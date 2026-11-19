import { Button, host, Input, Popover, PopoverContent, PopoverTrigger, useValue } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'session-handoff-review'
let context = null
let inFlight = false
let pending = null
let lastStatus = null
let retryable = false
let repaint = () => {}
const PREPARE_TIMEOUT_MS = 300000
let polling = false

async function ack(request, status, newId, diagnostic = {}) {
  return context.rest(`/request/${encodeURIComponent(request.requestId)}/ack`, {
    method: 'POST', body: { profile: request.profile, status, newId, claim: request.claim, ...diagnostic }, timeoutMs: 8000
  })
}

export async function refreshStatus() {
  if (!context) return
  const focused = host.state.focusedStoredSessionId.get()
  const owner = host.state.focusedSessionOwner.get()
  const legacy = focused && owner?.profile && context.storage.get(`handoff:${owner.profile}:${focused}`, null)
  const reference = context.storage.get('lastRequest', null) ??
    (legacy?.token ? { requestId: legacy.token, profile: owner.profile } : null)
  if (!reference?.requestId || !reference?.profile) return
  try {
    const item = await context.rest(`/request/${encodeURIComponent(reference.requestId)}?profile=${encodeURIComponent(reference.profile)}`, { timeoutMs: 8000 })
    if (item.requestId !== reference.requestId || item.profile !== reference.profile) return
    lastStatus = { requestId: item.requestId, profile: item.profile, oldId: item.oldId,
      oldTitle: item.oldTitle, title: item.title, newId: item.newId,
      status: item.status, stage: item.stage, reason: item.reason }
    retryable = false
    if (item.status === 'failed' && (item.stage == null || item.stage === 'claim') && !item.newId && item.oldId === focused && item.profile === owner?.profile &&
        item.oldTitle && item.title && !context.storage.get(`handoff:${item.profile}:${item.oldId}`, null)) {
      const route = await routeFor(item.profile)
      const inventory = await rows(route, item.profile)
      const old = exact(inventory, item.oldId)
      const found = await host.requestProfile(route, 'session.list', { title: item.title })
      retryable = old?.title === item.oldTitle && old.source === 'desktop' && old.profile === item.profile &&
        old.archived === false && old.pinned === true && !inventory.some(row => row.title === item.title) &&
        Array.isArray(found.sessions) && found.sessions.length === 0 &&
        host.state.focusedStoredSessionId.get() === focused
    }
    repaint()
  } catch { /* retain last known state */ }
}

export async function pollPreparation() {
  if (!pending || pending.phase === 'writing' || pending.phase === 'claiming' || pending.phase === 'registering' || polling || !context) return
  polling = true
  const request = pending
  try {
    if (Date.now() - request.startedAt > PREPARE_TIMEOUT_MS) {
      const item = await context.rest(`/request/${encodeURIComponent(request.requestId)}?profile=${encodeURIComponent(request.profile)}`, { timeoutMs: 8000 })
      if (item.status === 'ready' && request === pending) { await fromAgentEvent({ payload: item }); return }
      if (request !== pending) return
      pending = null; await refreshStatus(); repaint()
      if (item.status === 'preparing') {
        try { await ack(request, 'cancelled') } catch { /* uncertain; never auto-retry */ }
      }
      host.notify({ kind: 'error', message: 'Срок подготовки истек: передача не получена. Новый чат не создавался; проверьте статус перед повтором.' })
      return
    }
    const item = await context.rest(`/request/${encodeURIComponent(request.requestId)}?profile=${encodeURIComponent(request.profile)}`, { timeoutMs: 8000 })
    if (item.status === 'ready' && request === pending) await fromAgentEvent({ payload: item })
    else if (['cancelled', 'failed', 'completed'].includes(item.status) && request === pending) {
      pending = null; await refreshStatus(); repaint()
      host.notify({ kind: 'error', message: `Заявка закрыта (${item.status}); автоматический повтор запрещён. Проверьте состояние сессий.` })
    }
  } catch (error) {
    if (request === pending) {
      pending = null; await refreshStatus(); repaint()
      host.notify({ kind: 'error', message: `Не удалось проверить доставку передачи: ${error.message}. Новый чат автоматически не создаётся.` })
    }
  } finally { polling = false }
}

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
  const previous = context.storage.get('lastRequest', null)
  if (lastStatus?.oldId === oldId && lastStatus.status === 'failed') {
    requireState(retryable && previous?.requestId === lastStatus.requestId && previous.profile === profile &&
      !context.storage.get(`handoff:${profile}:${oldId}`, null), 'Previous handoff is not proven safe to retry')
    const route = await routeFor(profile)
    const inventory = await rows(route, profile)
    const old = exact(inventory, oldId)
    const found = await host.requestProfile(route, 'session.list', { title: lastStatus.title })
    requireState(old?.title === oldTitle && old.pinned === true && old.archived === false &&
      !inventory.some(row => row.title === lastStatus.title) &&
      Array.isArray(found.sessions) && found.sessions.length === 0, 'Previous handoff changed; retry blocked')
    const previousItem = await context.rest(`/request/${encodeURIComponent(previous.requestId)}?profile=${encodeURIComponent(profile)}`, { timeoutMs: 8000 })
    requireState(previousItem.status === 'failed' && (previousItem.stage == null || previousItem.stage === 'claim') &&
      !previousItem.newId && previousItem.oldId === oldId &&
      previousItem.oldTitle === oldTitle && previousItem.title === lastStatus.title, 'Previous request changed; retry blocked')
  }
  const requestId = crypto.randomUUID()
  const owner = host.state.focusedSessionOwner.get()
  requireState(owner?.connectionId, 'Missing owner connection')
  const text = `Пользователь уже подтвердил переезд кнопкой Desktop ↗ в «${title}». Идентификатор заявки: ${requestId}. Исходный чат: «${oldTitle}», ID ${oldId}, профиль ${profile}. Составь короткую передачу: только фактически известные и проверенные результаты, открытые вопросы, следующий шаг. Не выдумывай проверок и достижений. Вызови prepare_desktop_handoff ровно один раз с old_id, old_title, profile, title, request_id и handoff. Не спрашивай дополнительного подтверждения, не предлагай копировать текст. Событие доставки не подтверждает завершение переезда; Desktop проверит новый чат и закрепления. Старый чат не архивировать и не удалять.`
  pending = { oldId, oldTitle, profile, title, requestId, connectionId: owner.connectionId, startedAt: Date.now(), phase: 'registering' }
  repaint()
  try {
    const registered = await context.rest('/request', { method: 'POST', body: { requestId, oldId, oldTitle, profile, title }, timeoutMs: 8000 })
    requireState(registered?.status === 'preparing', 'Desktop request was not registered')
    requireState(host.state.focusedStoredSessionId.get() === oldId &&
      host.state.focusedSessionOwner.get()?.connectionId === owner.connectionId &&
      host.state.focusedSessionOwner.get()?.profile === profile, 'Focused owner changed before submit')
    requireState(pending?.requestId === requestId, 'Preparation stopped before submit')
    pending.phase = 'preparing'
    repaint()
    requireState(host.composer.submit(runtimeId, text) === true, 'Composer did not accept preparation request')
    context.storage.set('lastRequest', { requestId, profile })
  } catch (error) {
    if (pending?.requestId === requestId) pending = null
    try { await ack({ requestId, profile }, 'cancelled') } catch { /* unknown registration state */ }
    repaint(); throw error
  }
}

export function stopPreparation() {
  if (!pending || pending.phase === 'writing' || pending.phase === 'claiming' || pending.phase === 'registering') return false
  const stopped = pending
  pending = null
  void ack(stopped, 'cancelled').catch(() => host.notify({ kind: 'error', message: 'Не удалось подтвердить остановку. Проверьте состояние заявки.' }))
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
      if (lastStatus?.oldId === expectedId && lastStatus.status === 'failed') {
        requireState(retryable && old.pinned === true && !context.storage.get(`handoff:${profile}:${expectedId}`, null), 'Previous handoff is not proven safe to retry')
        const found = await host.requestProfile(route, 'session.list', { title: lastStatus.title })
        requireState(!inventory.some(row => row.title === lastStatus.title) && Array.isArray(found.sessions) && found.sessions.length === 0,
          'Previous handoff title exists; retry blocked')
      }
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
  if (pending && pending.oldId === oldId) return jsx(Button, { type: 'button', variant: 'ghost', disabled: pending.phase !== 'preparing',
    onClick: () => stopPreparation(), children: ['writing', 'claiming'].includes(pending.phase) ? 'Проверяю перенос…' : pending.phase === 'registering' ? 'Регистрирую заявку…' : 'Готовлю передачу… Стоп' })
  if (lastStatus?.oldId === oldId && (lastStatus.status === 'writing' || (lastStatus.status === 'failed' && !retryable))) return jsx(Button, {
    type: 'button', variant: 'ghost', disabled: true,
    title: `Заявка ${lastStatus.requestId}: ${lastStatus.status} · ${lastStatus.stage ?? 'unknown'} / ${lastStatus.reason ?? 'unknown'}. Проверьте сессии; автоматического повтора нет.`,
    children: lastStatus.status === 'writing' ? 'Переезд: writing · статус не подтверждён' :
      `Переезд остановлен · ${lastStatus.stage ?? 'unknown'} / ${lastStatus.reason ?? 'unknown'}` })
  return jsxs(Popover, { open, onOpenChange: next => void onOpen(next), children: [
    jsx(PopoverTrigger, { asChild: true, children: jsx(Button, {
      type: 'button', variant: 'ghost', title: retryable && lastStatus?.oldId === oldId ? `Заявка ${lastStatus.requestId} завершилась ошибкой без обнаруженного нового чата. Новая попытка требует отдельного подтверждения.` : tooltip, 'aria-label': tooltip,
      className: 'h-(--composer-control-size) shrink-0 rounded-md px-2 text-xs font-normal',
      style: { color: COLORS[badge.tone], fontVariantNumeric: 'tabular-nums' }, children: retryable && lastStatus?.oldId === oldId ? 'Новая попытка' : badge.label
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
    pending.phase = 'claiming'
    pending.claim = crypto.randomUUID()
    repaint()
    await ack(pending, 'writing')
    requireState(pending?.requestId === requestId, 'Preparation stopped before write')
    pending.phase = 'writing'
    pending.stage = 'create'
    const token = requestId
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
    pending.stage = 'create_readback'
    list = await rows(route, profile)
    const newRow = exact(list, newId)
    requireState(newRow?.title === title && newRow.source === 'desktop' && newRow.profile === profile &&
      newRow.archived === false && !newRow.pinned && list.filter(row => row.title === title).length === 1,
      'Created session identity/readback mismatch')
    old = exact(list, oldId)
    requireState(old?.title === oldTitle && old.archived === false, 'Old session changed')
    pending.stage = 'submit'
    const receipt = await host.requestProfile(route, 'prompt.submit', {
      profile, session_id: created.session_id, text: handoff, submission_id: token + ':prompt', surface: 'gui'
    })
    requireState(receipt.admission_id === token + ':prompt' &&
      receipt.ref?.session_id === created.session_id && receipt.ref?.profile_id === profile &&
      ['queued', 'started', 'terminal'].includes(receipt.status), 'Prompt admission mismatch')
    pending.stage = 'transcript'
    const verified = await snapshot(route, profile, newId)
    requireState(verified.messages?.some(m => m.role === 'user' && (m.text ?? m.content) === handoff),
      'Handoff transcript not verified')
    pending.stage = 'pin_new'
    await pin(route, profile, newId, true, token + ':pin-new')
    pending.stage = 'open'
    await host.openSession(newId, { route, awaitHydration: true, forceResume: true })
    requireState(host.state.focusedStoredSessionId.get() === newId, 'New session is not focused')
    // Pin verified before switching old. If the old pin changed concurrently,
    // stop instead of overriding it. An already-unpinned old row needs no edit.
    pending.stage = 'unpin_old'
    old = exact(await rows(route, profile), oldId)
    requireState(old?.title === oldTitle && old.archived === false && typeof old.pinned === 'boolean', 'Old row changed')
    if (old.pinned) await pin(route, profile, oldId, false, token + ':unpin-old')
    context.storage.set(key, { status: 'verified', title, token, newId })
    pending.stage = 'complete_ack'
    await ack(pending, 'completed', newId)
    const completion = await context.rest(`/request/${encodeURIComponent(requestId)}?profile=${encodeURIComponent(profile)}`, { timeoutMs: 8000 })
    requireState(completion.status === 'completed' && completion.newId === newId, 'Completion acknowledgement readback mismatch')
    context.storage.set(key, { status: 'completed', title, token, newId })
    pending = null
    await refreshStatus()
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
    if (pending?.phase === 'writing' || pending?.phase === 'claiming') {
      try { await ack(pending, 'failed', undefined, {
        stage: pending.stage ?? (pending.phase === 'claiming' ? 'claim' : 'unknown'), reason: 'operation_failed'
      }) } catch { /* claim or ack uncertain; no automatic retry */ }
    }
    pending = null
    await refreshStatus()
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
    ctx.onDispose(host.onEvent('plugin.session-handoff-review.prepare', () => { void pollPreparation() }))
    ctx.setInterval(() => { void pollPreparation() }, 3000)
    ctx.setInterval(() => { void refreshStatus() }, 3000)
    void refreshStatus()
    ctx.register({ id: 'chip', area: 'composer.actions', order: 101, render: () => jsx(HandoffChip, {}) })
  }
}
