import { host } from '@hermes/plugin-sdk'

const ID = 'session-handoff-review'
let context = null
let inFlight = false

function requireState(ok, message) { if (!ok) throw new Error(message) }
function exact(rows, id) { return rows.find(row => row.id === id) }
function revision(snapshot) {
  requireState(Number.isSafeInteger(snapshot?.revision) && snapshot.revision >= 0, 'Missing session revision')
  return snapshot.revision
}
async function rows(route, profile) {
  const result = await host.listPersistedSessions(route, { profile, limit: 500 })
  requireState(Array.isArray(result.sessions) && !result.errors?.length && result.total <= 500,
    'Session inventory incomplete; no mutation allowed')
  return result.sessions
}
async function routeFor(profile) {
  const routes = await host.profileRoutes()
  const owner = host.state.focusedSessionOwner.get()
  requireState(owner?.profile === profile, 'Focused profile mismatch')
  const matches = routes.filter(route => route.connectionId === owner.connectionId && route.profile === profile)
  requireState(matches.length === 1, 'Ambiguous or unavailable Desktop owner route')
  return matches[0]
}
async function snapshot(route, profile, id) {
  const result = await host.requestProfile(route, 'session.resume', { profile, session_id: id, source: 'gui' })
  requireState(result.stored_session_id === id && result.session_id, 'Session resume identity mismatch')
  revision(result)
  return result
}
async function pin(route, profile, id, pinned, requestId) {
  const snap = await snapshot(route, profile, id)
  const result = await host.requestProfile(route, 'session.mutate', {
    session_id: id, request_id: requestId, expected_revision: snap.revision,
    operation: 'sidebar', payload: { pinned }
  })
  requireState(result.session_id === id && result.revision === snap.revision + 1,
    'Pin mutation receipt mismatch')
  const readback = exact(await rows(route, profile), id)
  requireState(readback?.pinned === pinned, 'Pin readback mismatch')
}

export async function runHandoff({ oldId, typedOldId, oldTitle, profile, title, handoff, confirmed }) {
  requireState(confirmed === true, 'Explicit user confirmation required')
  requireState(typeof oldId === 'string' && typedOldId === oldId, 'Old session ID confirmation mismatch')
  requireState(!inFlight, 'Handoff already in progress')
  requireState(context, 'Plugin not registered')
  requireState([oldId, oldTitle, profile, title, handoff].every(s => typeof s === 'string' && !!s.trim()),
    'Explicit old ID/title, profile, new title and handoff required')
  requireState(/^.+\s+[1-9]\d*$/.test(title.trim()) && title !== oldTitle, 'New title needs a numeric suffix')
  requireState(host.state.focusedStoredSessionId.get() === oldId, 'Old session is not focused')
  const key = `handoff:${profile}:${oldId}`
  requireState(!context.storage.get(key, null), 'Previous handoff exists; inspect its status before retry')
  inFlight = true
  try {
    const route = await routeFor(profile)
    let list = await rows(route, profile)
    let old = exact(list, oldId)
    requireState(old?.title === oldTitle, 'Old session title mismatch')
    requireState(old.source === 'desktop' && old.profile_name === profile && old.archived === false && typeof old.pinned === 'boolean',
      'Old session is not a verified Desktop row')
    requireState(!list.some(row => row.title === title), 'Title collision')
    const found = await host.requestProfile(route, 'session.list', { profile, scope: 'stored', title, limit: 500 })
    requireState(Array.isArray(found.sessions) && found.sessions.length === 0, 'Title collision')
    const token = crypto.randomUUID()
    // Durable latch is set before the first external write. An uncertain receipt
    // cannot cause an automatic second create/submit on re-entry.
    context.storage.set(key, { status: 'pending', title, token })
    const created = await host.requestProfile(route, 'session.create', {
      profile, source: 'gui', title, request_id: token + ':create'
    })
    const newId = created.stored_session_id
    requireState(newId && newId !== oldId && created.session_id && revision(created) >= 0,
      'Create receipt invalid')
    context.storage.set(key, { status: 'created', title, token, newId })
    list = await rows(route, profile)
    const newRow = exact(list, newId)
    requireState(newRow?.title === title && newRow.source === 'desktop' && newRow.profile_name === profile &&
      newRow.archived === false && !newRow.pinned && list.filter(row => row.title === title).length === 1,
      'Created session identity/readback mismatch')
    old = exact(list, oldId)
    requireState(old?.title === oldTitle && old.archived === false, 'Old session changed')
    const receipt = await host.requestProfile(route, 'prompt.submit', {
      profile, session_id: created.session_id, text: handoff, submission_id: token + ':prompt', surface: 'gui'
    })
    requireState(receipt.admission_id === token + ':prompt' &&
      receipt.ref?.session_id === created.session_id && receipt.ref?.profile_id === profile &&
      ['queued', 'started', 'terminal'].includes(receipt.status), 'Prompt admission mismatch')
    const verified = await snapshot(route, profile, newId)
    requireState(verified.messages?.some(m => m.role === 'user' && (m.text ?? m.content) === handoff),
      'Handoff transcript not verified')
    await pin(route, profile, newId, true, token + ':pin-new')
    await host.openSession(newId, { route, awaitHydration: true, forceResume: true })
    // Pin verified before switching old. If the old pin changed concurrently,
    // stop instead of overriding it. An already-unpinned old row needs no edit.
    old = exact(await rows(route, profile), oldId)
    requireState(old?.title === oldTitle && old.archived === false && typeof old.pinned === 'boolean', 'Old row changed')
    if (old.pinned) await pin(route, profile, oldId, false, token + ':unpin-old')
    context.storage.set(key, { status: 'completed', title, token, newId })
    return { newId, status: 'completed' }
  } finally { inFlight = false }
}

async function fromAgentEvent(event) {
  const payload = event?.payload
  // Events are gateway-wide, never let one Desktop window migrate another chat.
  if (payload?.confirmed !== true || payload.profile !== host.state.focusedSessionOwner.get()?.profile ||
      payload.oldId !== host.state.focusedStoredSessionId.get()) return
  try {
    await runHandoff({ ...payload, typedOldId: payload.oldId })
    host.notify({ kind: 'success', message: `Чат «${payload.title}» открыт` })
  } catch (error) {
    host.notify({ kind: 'error', message: `Переезд остановлен: ${error.message}` })
  }
}

export default {
  id: ID, name: 'Session handoff (review)', defaultEnabled: false,
  description: 'Explicit, confirmed Desktop session migration',
  register(ctx) {
    context = ctx
    ctx.onDispose(() => { context = null })
    ctx.onDispose(host.onEvent('plugin.session-handoff-review.prepare', fromAgentEvent))
  }
}
