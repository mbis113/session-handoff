import { Button, host, Input, Popover, PopoverContent, PopoverTrigger, useValue } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'session-handoff-review'
let context = null
let inFlight = false
let pending = null
let repaint = () => {}

// This is context occupancy, not the provider account's quota remaining.
export function contextBadge(usage) {
  const percent = usage?.context_percent
  if (!Number.isFinite(percent) || !Number.isFinite(usage?.context_max) || usage.context_max <= 0 || percent < 0) {
    return { label: '↗', tone: 'gray' }
  }
  const tone = percent < 35 ? 'gray' : percent < 40 ? 'green' : percent < 45 ? 'yellow' : 'red'
  return { label: `↗ ${usage.context_estimated ? '≈' : ''}${Math.round(Math.min(100, percent))}%`, tone }
}

export function suggestTitle(oldTitle, inventory) {
  const match = /^(.*?)(?:\s+[1-9]\d*)?$/.exec(oldTitle.trim())
  const stem = match?.[1]?.trim() || 'Чат'
  const used = new Set(inventory.map(row => row.title))
  let number = 2
  for (const row of inventory) {
    const found = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([1-9]\\d*)$`).exec(row.title)
    if (found) number = Math.max(number, Number(found[1]) + 1)
  }
  while (used.has(`${stem} ${number}`)) number++
  return `${stem} ${number}`
}

/** The button is the sole approval; the agent supplies only factual content. */
export async function requestPreparation({ oldId, oldTitle, profile, title }) {
  requireState(oldId && host.state.focusedStoredSessionId.get() === oldId &&
    host.state.focusedSessionOwner.get()?.profile === profile, 'Old chat focus changed')
  requireState(oldTitle && /^.+\s+[1-9]\d*$/.test(title?.trim()) && title !== oldTitle, 'Invalid new title')
  requireState(!pending && !inFlight, 'Handoff already pending')
  const runtimeId = host.state.focusedSessionId.get()
  requireState(runtimeId && !host.state.busy.get() && typeof host.composer?.submit === 'function', 'Composer unavailable')
  const requestId = crypto.randomUUID()
  const owner = host.state.focusedSessionOwner.get()
  const text = `Пользователь уже подтвердил переезд кнопкой Desktop ↗ в «${title}». Идентификатор заявки: ${requestId}. Исходный чат: «${oldTitle}», ID ${oldId}, профиль ${profile}. Составь короткую передачу: только фактически известные и проверенные результаты, открытые вопросы, следующий шаг. Не выдумывай проверок и достижений. Вызови prepare_desktop_handoff ровно один раз с old_id, old_title, profile, title, request_id и handoff. Не спрашивай дополнительного подтверждения, не предлагай копировать текст. Событие доставки не подтверждает завершение переезда; Desktop проверит новый чат и закрепления. Старый чат не архивировать и не удалять.`
  pending = { oldId, oldTitle, profile, title, requestId, connectionId: owner.connectionId }
  repaint()
  try {
    requireState(host.composer.submit(runtimeId, text) === true, 'Composer did not accept preparation request')
  } catch (error) { pending = null; repaint(); throw error }
}

export function stopPreparation() {
  if (!pending || pending.phase === 'writing') return false
  pending = null
  repaint()
  host.notify({ kind: 'info', message: 'Подготовка остановлена. Старый чат не изменён.' })
  return true
}

const COLORS = {
  gray: 'var(--ui-text-quaternary)', green: 'var(--ui-green)',
  yellow: 'var(--ui-yellow)', red: 'var(--ui-red)'
}

function HandoffChip() {
  const oldId = useValue(host.state.focusedStoredSessionId)
  const owner = useValue(host.state.focusedSessionOwner)
  const runtimeId = useValue(host.state.focusedSessionId)
  const usage = useValue(host.state.focusedUsage)
  const busy = useValue(host.state.busy)
  const [open, setOpen] = useState(false)
  const [proposal, setProposal] = useState(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [estimate, setEstimate] = useState(null)
  const [, setProgressVersion] = useState(0)
  useEffect(() => {
    repaint = () => setProgressVersion(value => value + 1)
    return () => { repaint = () => {} }
  }, [])
  const badge = contextBadge(usage?.context_max > 0 && Number.isFinite(usage?.context_percent) ? usage : !busy && estimate?.id === runtimeId && estimate.owner === `${owner?.connectionId}:${owner?.profile}` ? estimate.value : null)

  useEffect(() => {
    let cancelled = false
    setEstimate(null)
    if (!runtimeId || busy || (usage?.context_max > 0 && Number.isFinite(usage?.context_percent))) return () => { cancelled = true }
    const fetch = async () => {
      try {
        const route = await routeFor(owner?.profile)
        const value = await host.requestProfile(route, 'session.context_breakdown', { session_id: runtimeId })
        if (!cancelled && host.state.focusedSessionId.get() === runtimeId && value?.context_max > 0) setEstimate({ id: runtimeId, owner: `${owner?.connectionId}:${owner?.profile}`, value })
      } catch { if (!cancelled) setEstimate(null) }
    }
    void fetch()
    return () => { cancelled = true }
  }, [runtimeId, busy, usage?.context_percent, usage?.context_max, owner?.connectionId, owner?.profile])

  async function onOpen(next) {
    setOpen(next)
    if (!next) { setProposal(null); setError(''); return }
    setProposal(null); setTitle(''); setError(''); setLoading(true)
    const expectedId = host.state.focusedStoredSessionId.get()
    try {
      const profile = host.state.focusedSessionOwner.get()?.profile
      requireState(expectedId && profile, 'No focused Desktop chat')
      const route = await routeFor(profile)
      const inventory = await rows(route, profile)
      const old = exact(inventory, expectedId)
      requireState(old?.source === 'desktop' && old.profile === profile && old.archived === false, 'Focused chat is not a Desktop session')
      if (host.state.focusedStoredSessionId.get() !== expectedId) return
      setProposal({ oldId: expectedId, oldTitle: old.title, profile })
      setTitle(suggestTitle(old.title, inventory))
    } catch (cause) { setError(cause.message) }
    finally { setLoading(false) }
  }

  async function move() {
    setError('')
    try {
      requireState(proposal, 'No proposal')
      await requestPreparation({ ...proposal, title: title.trim() })
      setOpen(false)
      host.notify({ kind: 'info', message: 'Начался переезд…' })
    } catch (cause) { setError(cause.message) }
  }

  const tooltip = badge.label === '↗' ? 'Занятость контекста неизвестна · переезд' : `Занятость контекста: ${badge.label.slice(2)} · переезд`
  if (pending && pending.oldId === oldId) return jsx(Button, { type: 'button', variant: 'ghost', disabled: pending.phase === 'writing',
    onClick: () => stopPreparation(), children: pending.phase === 'writing' ? 'Завершаю перенос…' : 'Начался переезд… Стоп' })
  return jsxs(Popover, { open, onOpenChange: next => void onOpen(next), children: [
    jsx(PopoverTrigger, { asChild: true, children: jsx(Button, {
      type: 'button', variant: 'ghost', title: tooltip, 'aria-label': tooltip,
      className: 'h-(--composer-control-size) shrink-0 rounded-md px-2 text-xs font-normal',
      style: { color: COLORS[badge.tone], fontVariantNumeric: 'tabular-nums' }, children: badge.label
    }) }),
    jsx(PopoverContent, { align: 'end', side: 'top', sideOffset: 8,
      style: { padding: 12, width: 'min(310px, calc(100vw - 32px))' },
      children: jsxs('div', { style: { display: 'grid', gap: 8, fontSize: '0.75rem' }, children: [
        jsx('strong', { children: 'Переезд в новую сессию' }),
        jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Кнопка «Переезд» — единственное подтверждение. Агент подготовит фактическую передачу, затем плагин автоматически создаст и проверит новый чат.' }),
        loading ? jsx('span', { children: 'Проверяю чат…' }) : null,
        proposal ? jsx(Input, { 'aria-label': 'Название нового чата', value: title, onChange: event => setTitle(event.target.value) }) : null,
        error ? jsx('span', { role: 'alert', style: { color: 'var(--ui-red)' }, children: error }) : null,
        jsxs('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' }, children: [
          jsx(Button, { type: 'button', variant: 'ghost', onClick: () => setOpen(false), children: 'Отмена' }),
          jsx(Button, { type: 'button', disabled: !proposal || loading || busy, onClick: () => void move(), children: 'Переехать' })
        ] })
      ] })
    })
  ] })
}

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

export async function runHandoff({ oldId, oldTitle, profile, title, handoff, requestId }) {
  requireState(pending && pending.requestId === requestId && pending.oldId === oldId &&
    pending.oldTitle === oldTitle && pending.profile === profile && pending.title === title &&
    pending.connectionId === host.state.focusedSessionOwner.get()?.connectionId,
    'No matching approved Desktop request')
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
    requireState(old.source === 'desktop' && old.profile === profile && old.archived === false && typeof old.pinned === 'boolean',
      'Old session is not a verified Desktop row')
    requireState(!list.some(row => row.title === title), 'Title collision')
    // Title lookup resolves hidden/canonical rows too; scope and title are mutually exclusive.
    const found = await host.requestProfile(route, 'session.list', { title })
    requireState(Array.isArray(found.sessions) && found.sessions.length === 0, 'Title collision')
    requireState(pending?.requestId === requestId, 'Preparation stopped before write')
    const token = crypto.randomUUID()
    // Durable latch is set before the first external write. An uncertain receipt
    // cannot cause an automatic second create/submit on re-entry.
    // The Stop gate closes before the first write; no await between these steps.
    pending.phase = 'writing'
    repaint()
    context.storage.set(key, { status: 'pending', title, token })
    host.notify({ kind: 'info', message: 'Завершаю перенос…' })
    const created = await host.requestProfile(route, 'session.create', {
      profile, source: 'gui', title, request_id: token + ':create'
    })
    const newId = created.stored_session_id
    requireState(newId && newId !== oldId && created.session_id && revision(created) >= 0,
      'Create receipt invalid')
    context.storage.set(key, { status: 'created', title, token, newId })
    list = await rows(route, profile)
    const newRow = exact(list, newId)
    requireState(newRow?.title === title && newRow.source === 'desktop' && newRow.profile === profile &&
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
    requireState(host.state.focusedStoredSessionId.get() === newId, 'New session is not focused')
    // Pin verified before switching old. If the old pin changed concurrently,
    // stop instead of overriding it. An already-unpinned old row needs no edit.
    old = exact(await rows(route, profile), oldId)
    requireState(old?.title === oldTitle && old.archived === false && typeof old.pinned === 'boolean', 'Old row changed')
    if (old.pinned) await pin(route, profile, oldId, false, token + ':unpin-old')
    context.storage.set(key, { status: 'completed', title, token, newId })
    pending = null
    repaint()
    return { newId, status: 'completed' }
  } finally { inFlight = false }
}

async function fromAgentEvent(event) {
  const payload = event?.payload
  // Events are gateway-wide, never let one Desktop window migrate another chat.
  if (!pending || typeof payload?.requestId !== 'string' || payload.requestId !== pending.requestId ||
      payload.profile !== pending.profile || payload.oldId !== pending.oldId ||
      payload.oldTitle !== pending.oldTitle || payload.title !== pending.title ||
      payload.profile !== host.state.focusedSessionOwner.get()?.profile ||
      pending.connectionId !== host.state.focusedSessionOwner.get()?.connectionId ||
      payload.oldId !== host.state.focusedStoredSessionId.get()) return
  try {
    await runHandoff(payload)
    host.notify({ kind: 'success', message: 'Вы можете продолжить работу в новой сессии' })
  } catch (error) {
    pending = null
    repaint()
    host.notify({ kind: 'error', message: `Переезд остановлен: ${error.message}. Проверьте состояние нового чата и закрепления; повтор автоматически не выполняется.` })
  }
}

export default {
  id: ID, name: 'Session handoff (review)', defaultEnabled: false,
  description: 'Explicit, confirmed Desktop session migration',
  register(ctx) {
    context = ctx
    ctx.onDispose(() => { context = null; pending = null })
    ctx.onDispose(host.onEvent('plugin.session-handoff-review.prepare', fromAgentEvent))
    ctx.register({ id: 'chip', area: 'composer.actions', order: 101, render: () => jsx(HandoffChip, {}) })
  }
}
