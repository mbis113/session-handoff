import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

async function fixture(shared = {}) {
  const calls = [], events = new Map(), contributions = [], storage = shared.storage ?? new Map(), mailbox = shared.mailbox ?? new Map()
  const rows = [{ id: 'old', title: 'Старый чат', source: 'desktop', profile: 'default', archived: false, pinned: true }]
  const messages = { old: [], new: [] }, revisions = { old: 0, new: 0 }
  let focused = 'old', busy = false, accepted = true, transcript = true, opened = true
  const atom = value => ({ get: () => value() })
  const host = {
    state: { focusedStoredSessionId: atom(() => focused), focusedSessionId: atom(() => focused === 'old' ? 'runtime-old' : 'new'), focusedSessionOwner: atom(() => ({ connectionId: 'local', profile: 'default' })), busy: atom(() => busy), focusedUsage: atom(() => null) },
    composer: { submit(id, text) { calls.push(['composer.submit', id, text]); return accepted } },
    profileRoutes: async () => [{ connectionId: 'local', profile: 'default' }],
    listPersistedSessions: async () => ({ sessions: structuredClone(rows), total: rows.length, errors: [] }),
    async requestProfile(route, method, p) {
      calls.push([method, p])
      if (method === 'session.list') return { sessions: rows.filter(r => r.title === p.title) }
      if (method === 'session.create') { rows.push({ id: 'new', title: p.title, profile: 'default', source: 'desktop', pinned: false, archived: false }); return { stored_session_id: 'new', session_id: 'new', revision: 0 } }
      if (method === 'prompt.submit') { if (transcript) messages.new.push({ role: 'user', text: p.text }); return { admission_id: p.submission_id, ref: { session_id: 'new', profile_id: 'default' }, status: 'started' } }
      if (method === 'session.resume') return { stored_session_id: p.session_id, session_id: p.session_id, revision: revisions[p.session_id], messages: messages[p.session_id] }
      if (method === 'session.mutate') { rows.find(r => r.id === p.session_id).pinned = p.payload.pinned; return { session_id: p.session_id, revision: ++revisions[p.session_id] } }
      if (method === 'session.context_breakdown') return {}
      throw Error(method)
    },
    async openSession(id) { calls.push(['openSession', id]); if (!opened) throw Error('cannot open'); focused = id },
    notify(p) { calls.push(['notify', p]) },
    onEvent(name, fn) { events.set(name, fn); return () => events.delete(name) }
  }
  let hooks = [], index = 0
  globalThis.__sdk = { host, useValue: a => a.get(), Button: 'Button', Input: 'Input', Popover: 'Popover', PopoverTrigger: 'PopoverTrigger', PopoverContent: 'PopoverContent' }
  globalThis.__react = { useState(initial) { const i = index++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], v => { hooks[i] = v }] }, useEffect() {} }
  globalThis.__jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  const source = (await fs.readFile(new URL('./desktop/plugin.js', import.meta.url), 'utf8'))
    .replace(/^import .* from '@hermes\/plugin-sdk'$/m, 'const { host, useValue, Button, Input, Popover, PopoverTrigger, PopoverContent } = globalThis.__sdk')
    .replace(/^import .* from 'react'$/m, 'const { useState, useEffect } = globalThis.__react')
    .replace(/^import .* from 'react\/jsx-runtime'$/m, 'const { jsx, jsxs } = globalThis.__jsx')
  const mod = await import(`data:text/javascript,${encodeURIComponent(source)}#${Math.random()}`)
  const rest = async (path, options = {}) => {
    calls.push(['rest', path, options])
    if (path === '/request' && options.method === 'POST') {
      const body = options.body
      if (mailbox.has(body.requestId)) throw Error('duplicate')
      mailbox.set(body.requestId, { ...body, status: 'preparing' })
      return { status: 'preparing' }
    }
    const match = /^\/request\/([^/?]+)(\/ack)?(?:\?profile=.*)?$/.exec(path)
    if (!match) throw Error(`Unknown REST ${path}`)
    const item = mailbox.get(decodeURIComponent(match[1]))
    if (!item) throw Error('Unknown request')
    if (match[2]) { if (options.body.status === 'completed' && item.rejectCompleted) throw Error('ack lost'); Object.assign(item, { status: options.body.status, newId: options.body.newId, stage: options.body.stage, reason: options.body.reason }); return { status: item.status } }
    return structuredClone(item)
  }
  mod.default.register({ rest, setInterval: fn => { globalThis.__poll = fn; return () => {} }, storage: { get: (k, d) => storage.get(k) ?? d, set: (k, v) => storage.set(k, v) }, register: c => contributions.push(c), onDispose() {} })
  const render = () => { index = 0; return contributions[0].render().type() }
  const fire = async payload => { if (mailbox.has(payload?.requestId) && payload.oldId === 'old' && payload.profile === 'default' && payload.title === mailbox.get(payload.requestId).title) Object.assign(mailbox.get(payload.requestId), payload, { status: 'ready' }); await mod.pollPreparation() }
  const payload = () => ({ oldId: 'old', oldTitle: 'Старый чат', profile: 'default', title: 'Старый чат 2', handoff: 'Проверено: файл. Далее: тест.', requestId: calls.find(c => c[0] === 'composer.submit')?.[2].match(/Идентификатор заявки: ([a-f0-9-]+)/)?.[1] })
  return { host, calls, rows, render, fire, payload, mod, mailbox, storage, poll: () => mod.pollPreparation(), setAccepted: v => { accepted = v }, setTranscript: v => { transcript = v }, setFocus: v => { focused = v }, setBusy: v => { busy = v }, setOpened: v => { opened = v } }
}

function findButton(f, label) {
  const stack = [...f.render().props.children[1].props.children.props.children]
  while (stack.length) {
    const node = stack.shift()
    if (node?.type === 'Button' && node.props.children === label) return node
    if (Array.isArray(node?.props?.children)) stack.push(...node.props.children)
  }
  throw new Error(`Button «${label}» not found`)
}

async function approve(f) {
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  const tree = f.render()
  const children = tree.props.children[1].props.children.props.children
  const input = children.find(c => c?.type === 'Input')
  input.props.onChange({ target: { value: 'Старый чат 2' } })
  await findButton(f, 'Переехать').props.onClick()
}

test('one button confirmation authorizes factual preparation without asking chat approval', async () => {
  const f = await fixture(); await approve(f)
  const request = f.calls.find(c => c[0] === 'composer.submit')?.[2]
  assert.match(request, /prepare_desktop_handoff/)
  assert.doesNotMatch(request, /дождись моего|отдельного подтверждения|покажи заголовок и текст передачи мне/i)
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('unsolicited event cannot create a chat even with confirmed=true', async () => {
  const f = await fixture(); await f.fire({ ...f.payload(), confirmed: true })
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('approved matching agent event migrates exactly once and reports completion', async () => {
  const f = await fixture(); await approve(f)
  await f.fire({ ...f.payload(), confirmed: true }); await f.fire({ ...f.payload(), confirmed: true })
  assert.equal(f.calls.filter(c => c[0] === 'session.create').length, 1)
  assert.equal(f.rows.find(r => r.id === 'old').pinned, false)
  assert.equal(f.rows.find(r => r.id === 'new').pinned, true)
  assert.ok(f.calls.some(c => c[0] === 'notify' && c[1].message === 'Вы можете продолжить работу в новой сессии'))
})

test('wrong approved title, profile, or old id cannot migrate', async () => {
  const f = await fixture(); await approve(f)
  for (const alteration of [{ title: 'Другое 2' }, { profile: 'other' }, { oldId: 'other' }]) await f.fire({ ...f.payload(), ...alteration, confirmed: true })
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('rejected composer request leaves no pending authorization', async () => {
  const f = await fixture(); f.setAccepted(false); await approve(f)
  await f.fire({ ...f.payload(), confirmed: true })
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('pending chip shows Stop only before write and clears on stop', async () => {
  const f = await fixture(); await approve(f)
  const chip = f.render()
  assert.match(chip.props.children, /Готовлю передачу.*Стоп/)
  chip.props.onClick()
  assert.equal(f.render().type, 'Popover')
})

test('stop during preparation invalidates approval before any write', async () => {
  const f = await fixture(); await approve(f)
  assert.equal(f.mod.stopPreparation(), true)
  await f.fire(f.payload())
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('Stop during preflight prevents first external write', async () => {
  const f = await fixture(); await approve(f)
  let release
  const original = f.host.requestProfile
  f.host.requestProfile = async (...args) => {
    if (args[1] === 'session.list') await new Promise(resolve => { release = resolve })
    return original(...args)
  }
  const migration = f.fire(f.payload())
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.mod.stopPreparation(), true)
  release(); await migration
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('stop is unavailable once migration begins', async () => {
  const f = await fixture(); await approve(f)
  let release
  const original = f.host.requestProfile
  f.host.requestProfile = async (...args) => {
    if (args[1] === 'session.create') await new Promise(resolve => { release = resolve })
    return original(...args)
  }
  const migration = f.fire(f.payload())
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof release, 'function')
  assert.equal(f.mod.stopPreparation(), false)
  release(); await migration
  assert.equal(f.rows.find(r => r.id === 'old').pinned, false)
})

test('wrong request token cannot migrate', async () => {
  const f = await fixture(); await approve(f)
  await f.fire({ ...f.payload(), requestId: crypto.randomUUID() })
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('open failure preserves old pin and reports uncertain status', async () => {
  const f = await fixture(); await approve(f); f.setOpened(false)
  await f.fire(f.payload())
  assert.equal(f.rows.find(r => r.id === 'old').pinned, true)
  assert.ok(f.calls.some(c => c[0] === 'notify' && c[1].kind === 'error' && /повтор автоматически не выполняется/.test(c[1].message)))
})

test('unverified transcript keeps old pinned', async () => {
  const f = await fixture(); await approve(f); f.setTranscript(false)
  await f.fire({ ...f.payload(), confirmed: true })
  assert.equal(f.rows.find(r => r.id === 'old').pinned, true)
})

test('approved request is registered before composer submit and polling consumes durable handoff', async () => {
  const f = await fixture(); await approve(f)
  assert.ok(f.calls.findIndex(c => c[0] === 'rest' && c[1] === '/request') < f.calls.findIndex(c => c[0] === 'composer.submit'))
  const p = f.payload()
  Object.assign(f.mailbox.get(p.requestId), p, { status: 'ready' })
  await f.poll()
  assert.equal(f.rows.find(r => r.id === 'old').pinned, false)
  assert.equal(f.mailbox.get(p.requestId).status, 'completed')
})

test('pending preparation times out with failure instead of indefinite spinner', async () => {
  const f = await fixture(); await approve(f)
  const originalNow = Date.now
  Date.now = () => originalNow() + 400000
  try { await f.poll() } finally { Date.now = originalNow }
  assert.equal(f.render().type, 'Popover')
  assert.ok(f.calls.some(c => c[0] === 'notify' && c[1].kind === 'error' && /истек|не получен/i.test(c[1].message)))
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('lost completion acknowledgement never reports success', async () => {
  const f = await fixture(); await approve(f)
  const p = f.payload()
  Object.assign(f.mailbox.get(p.requestId), p, { status: 'ready' })
  f.mailbox.get(p.requestId).rejectCompleted = true
  await f.poll()
  assert.equal(f.calls.some(c => c[0] === 'notify' && c[1].kind === 'success'), false)
  assert.equal(f.rows.find(r => r.id === 'new').pinned, true)
})

test('failed writing ack stores bounded diagnostic and keeps status visible after reload', async () => {
  const f = await fixture(); await approve(f); f.setOpened(false)
  const p = f.payload()
  await f.fire(p)
  const item = f.mailbox.get(p.requestId)
  assert.equal(item.status, 'failed')
  assert.equal(item.stage, 'open')
  assert.equal(item.reason, 'operation_failed')
  assert.equal(JSON.stringify(item).includes('cannot open'), false)
  assert.match(JSON.stringify(f.render()), /open.*operation_failed/)
  const restarted = await fixture({ mailbox: f.mailbox, storage: f.storage })
  await restarted.mod.refreshStatus()
  assert.match(JSON.stringify(restarted.render()), /open.*operation_failed/)
  assert.equal(restarted.calls.some(c => c[0] === 'session.create'), false)
})

test('uncertain writing status stays visible after reload without retry', async () => {
  const f = await fixture(); await approve(f)
  const p = f.payload()
  Object.assign(f.mailbox.get(p.requestId), { status: 'writing' })
  const restarted = await fixture({ mailbox: f.mailbox, storage: f.storage })
  await restarted.mod.refreshStatus()
  assert.match(JSON.stringify(restarted.render()), /writing/)
  assert.equal(restarted.calls.some(c => c[0] === 'session.create'), false)
})

test('legacy local latch resolves existing failed request without new request', async () => {
  const storage = new Map([['handoff:default:old', { token: 'legacy', status: 'created' }]])
  const mailbox = new Map([['legacy', { requestId: 'legacy', profile: 'default', oldId: 'old', status: 'failed', stage: null, reason: null }]])
  const f = await fixture({ storage, mailbox })
  await f.mod.refreshStatus()
  assert.match(JSON.stringify(f.render()), /unknown.*unknown/)
  assert.equal(f.calls.some(c => c[0] === 'session.create' || c[0] === 'composer.submit'), false)
})

test('proven failed no-write request offers explicit retry and preserves historical row until approval', async () => {
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', stage: null, reason: null, newId: null }]])
  const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  const retry = f.render()
  assert.equal(retry.props.children[0].props.children.props.children, 'Новая попытка')
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
  await retry.props.onOpenChange(true)
  assert.equal(f.render().type, 'Popover')
  assert.equal(f.mailbox.get('failed-old').status, 'failed')
  assert.equal(f.storage.get('lastRequest').requestId, 'failed-old')
  await approve(f)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.mailbox.get('failed-old').status, 'failed')
  assert.notEqual(f.storage.get('lastRequest').requestId, 'failed-old', JSON.stringify(f.calls.filter(c => c[0] === 'notify')))
  assert.equal(f.rows[0].pinned, true)
  assert.equal(f.calls.some(c => c[0] === 'session.create'), false)
})

test('failed retry registration preserves historical lastRequest reference', async () => {
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', newId: null }]])
  const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  f.setAccepted(false)
  await findButton(f, 'Переехать').props.onClick()
  assert.equal(f.storage.get('lastRequest').requestId, 'failed-old')
  assert.equal(f.mailbox.get('failed-old').status, 'failed')
})

test('retry refuses title collision arising after opening before approval', async () => {
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', newId: null }]])
  const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  await f.render().props.onOpenChange(true)
  f.rows.push({ id: 'partial', title: 'Старый чат 2', source: 'desktop', profile: 'default', archived: false, pinned: false })
  await findButton(f, 'Переехать').props.onClick()
  assert.equal(f.calls.some(c => c[0] === 'composer.submit'), false)
  assert.equal(f.storage.get('lastRequest').requestId, 'failed-old')
})

test('failed request at or after write stage stays blocked even if title is absent', async () => {
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', stage: 'create', reason: 'operation_failed', newId: null }]])
  const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  assert.match(JSON.stringify(f.render()), /Переезд остановлен/)
})

test('matching pending pre-create latch allows explicit retry without erasing historical audit', async () => {
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', stage: null, reason: null, newId: null }]])
  const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }],
    ['handoff:default:old', { token: 'failed-old', status: 'pending', title: 'Старый чат 2' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  assert.match(JSON.stringify(f.render()), /Новая попытка/)
  assert.equal(f.calls.some(c => c[0] === 'session.create' || c[0] === 'composer.submit'), false)
  await approve(f)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.some(c => c[0] === 'composer.submit'), true, JSON.stringify(f.calls))
  assert.equal(f.mailbox.get('failed-old').status, 'failed')
  assert.deepEqual(f.storage.get('handoff:default:old'), { token: 'failed-old', status: 'pending', title: 'Старый чат 2' })
  const retry = f.payload()
  assert.notEqual(retry.requestId, 'failed-old')
  await f.fire(retry)
  assert.equal(f.calls.filter(c => c[0] === 'session.create').length, 1, JSON.stringify(f.calls))
  assert.equal(f.storage.get('handoff:default:old').status, 'completed')
  assert.equal(f.mailbox.get('failed-old').status, 'failed')
})

test('failed request with an unsafe latch or existing recorded title cannot enable retry', async () => {
  for (const condition of ['created', 'verified', 'completed', 'unknown', 'newId', 'legacy-created', 'title']) {
    const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', stage: null, reason: null, newId: null }]])
    const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }]])
    if (condition !== 'title') storage.set('handoff:default:old', {
      token: condition === 'legacy-created' ? 'other' : 'failed-old',
      status: condition === 'newId' ? 'pending' : condition,
      title: 'Старый чат 2',
      ...(condition === 'newId' ? { newId: 'new' } : {})
    })
    const f = await fixture({ mailbox, storage })
    if (condition === 'title') f.rows.push({ id: 'partial', title: 'Старый чат 2', source: 'desktop', profile: 'default', archived: false, pinned: false })
    await f.mod.refreshStatus()
    assert.match(JSON.stringify(f.render()), /Переезд остановлен/)
    assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
  }
})

test('retry works without stored lastRequest when the pending latch token matches', async () => {
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', stage: null, reason: null, newId: null }]])
  const storage = new Map([['handoff:default:old', { token: 'failed-old', status: 'pending', title: 'Старый чат 2' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  assert.match(JSON.stringify(f.render()), /Новая попытка/)
  await approve(f)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.some(c => c[0] === 'composer.submit'), true, JSON.stringify(f.calls.filter(c => c[0] === 'notify')))
  const retry = f.payload()
  assert.notEqual(retry.requestId, 'failed-old')
  assert.equal(f.storage.get('lastRequest').requestId, retry.requestId)
  await f.fire(retry)
  assert.equal(f.calls.filter(c => c[0] === 'session.create').length, 1)
  assert.equal(f.mailbox.get('failed-old').status, 'failed')
})

test('retry without lastRequest stays blocked when a recorded title exists', async () => {
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', stage: null, reason: null, newId: null }]])
  const storage = new Map([['handoff:default:old', { token: 'failed-old', status: 'pending', title: 'Другое 2' }]])
  const f = await fixture({ mailbox, storage })
  f.rows.push({ id: 'other', title: 'Другое 2', source: 'desktop', profile: 'default', archived: false, pinned: false })
  await f.mod.refreshStatus()
  assert.match(JSON.stringify(f.render()), /Переезд остановлен/)
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
})

test('differing server and latch titles allow retry when both are absent', async () => {
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', stage: null, reason: null, newId: null }]])
  const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }],
    ['handoff:default:old', { token: 'failed-old', status: 'pending', title: 'Другое 2' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  assert.match(JSON.stringify(f.render()), /Новая попытка/)
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
})

test('legacy random-token pending latch retries after server-proven no-write failure', async () => {
  const legacyToken = crypto.randomUUID()
  const failed = '00000000-0000-4000-8000-000000000001'
  // Server intent lost its title (legacy request), latch token was written by
  // an old build as a random UUID — nothing ties it to `failed` except the
  // server-side proof that this exact request failed before any write.
  const mailbox = new Map([[failed, { requestId: failed, profile: 'default', oldId: 'old', oldTitle: 'Старый чат', status: 'failed', stage: null, reason: null, newId: null }]])
  const storage = new Map([['lastRequest', { requestId: failed, profile: 'default' }],
    ['handoff:default:old', { token: legacyToken, status: 'pending', title: '1212121212 2' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  assert.match(JSON.stringify(f.render()), /Новая попытка/)
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
  await approve(f)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.some(c => c[0] === 'composer.submit'), true, JSON.stringify(f.calls.filter(c => c[0] === 'notify')))
  assert.equal(f.mailbox.get(failed).status, 'failed')
  assert.deepEqual(f.storage.get('handoff:default:old'), { token: legacyToken, status: 'pending', title: '1212121212 2' })
  const retry = f.payload()
  assert.notEqual(retry.requestId, failed)
  await f.fire(retry)
  assert.equal(f.calls.filter(c => c[0] === 'session.create').length, 1)
  assert.equal(f.storage.get('handoff:default:old').status, 'completed')
  assert.equal(f.mailbox.get(failed).status, 'failed')
})

test('legacy latch with a recorded title that now exists blocks the explicit retry', async () => {
  const legacyToken = crypto.randomUUID()
  const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', status: 'failed', stage: null, reason: null, newId: null }]])
  const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }],
    ['handoff:default:old', { token: legacyToken, status: 'pending', title: 'Другое 2' }]])
  const f = await fixture({ mailbox, storage })
  await f.mod.refreshStatus()
  assert.match(JSON.stringify(f.render()), /Новая попытка/)
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  f.rows.push({ id: 'partial', title: 'Другое 2', source: 'desktop', profile: 'default', archived: false, pinned: false })
  await findButton(f, 'Переехать').props.onClick()
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
  assert.equal(f.mailbox.get('failed-old').status, 'failed')
  assert.equal(f.storage.get('lastRequest').requestId, 'failed-old')
  assert.deepEqual(f.storage.get('handoff:default:old'), { token: legacyToken, status: 'pending', title: 'Другое 2' })
})

test('update command construction targets the plugin clone via fetch and hard reset', async () => {
  const f = await fixture()
  const posix = f.mod.updateCommandFor(false)
  assert.match(posix, /\$HOME\/\.hermes/)
  assert.match(posix, /plugins\/session-handoff-review/)
  assert.match(posix, /git fetch -q --depth 1 origin HEAD && git reset -q --hard FETCH_HEAD && git log -1 --format=%h/)
  assert.match(posix, /exit 2$/)
  const windows = f.mod.updateCommandFor(true)
  assert.match(windows, /if exist "%HERMES_HOME%\\plugins\\session-handoff-review\\\.git"/)
  assert.match(windows, /cd \/d/)
  assert.match(windows, /exit \/b 2/)
  for (const command of [posix, windows]) {
    assert.match(command, /git fetch -q --depth 1 origin HEAD/)
    assert.match(command, /git reset -q --hard FETCH_HEAD/)
    assert.doesNotMatch(command, /git pull|git push/)
    assert.doesNotMatch(command, /prepare_desktop_handoff|session\.create/)
  }
})

test('update result parsing keeps a short hash or one bounded single-line reason', async () => {
  const f = await fixture()
  assert.deepEqual(f.mod.parseUpdateResult({ code: 0, stdout: 'abc1234\n' }), { ok: true, sha: 'abc1234', error: null })
  assert.deepEqual(f.mod.parseUpdateResult({ code: 0, stdout: 'warning: ……\nabcdef01\n' }), { ok: true, sha: 'abcdef01', error: null })
  assert.deepEqual(f.mod.parseUpdateResult({ code: 0, stdout: '' }), { ok: true, sha: null, error: null })
  const failure = f.mod.parseUpdateResult({ code: 128, stdout: '', stderr: Array(10).fill('fatal: cannot lock ref\n    at Object.<anonymous> (git.js:1:1)').join('\n') })
  assert.equal(failure.ok, false)
  assert.equal(failure.sha, null)
  assert.equal(failure.error.includes('\n'), false)
  assert.ok(failure.error.length <= 160, `error too long: ${failure.error.length}`)
  assert.match(failure.error, /fatal: cannot lock ref/)
  assert.deepEqual(f.mod.parseUpdateResult({ stdout: '' }), { ok: false, sha: null, error: 'код выхода ?' })
})

test('popover footer update button refreshes only the server half and shows the short hash', async () => {
  const f = await fixture()
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  const commands = []
  const original = f.host.requestProfile
  f.host.requestProfile = async (route, method, params, timeoutMs) => {
    if (method === 'shell.exec') {
      commands.push({ command: params.command, session_id: params.session_id, timeoutMs })
      return /%COMSPEC%/.test(params.command) ? { code: 0, stdout: '%COMSPEC%' } : { code: 0, stdout: 'abc1234\n' }
    }
    return original(route, method, params, timeoutMs)
  }
  await findButton(f, 'Обновить плагин на сервере').props.onClick()
  for (let i = 0; i < 20 && !JSON.stringify(f.render()).includes('abc1234'); i++) await new Promise(resolve => setImmediate(resolve))
  const updateCommands = commands.filter(c => !/%COMSPEC%/.test(c.command))
  assert.equal(updateCommands.length, 1, JSON.stringify(commands))
  assert.match(updateCommands[0].command, /git reset -q --hard FETCH_HEAD/)
  assert.equal(updateCommands[0].session_id, undefined)
  assert.equal(updateCommands[0].timeoutMs, 40000)
  const dom = JSON.stringify(f.render())
  assert.match(dom, /Серверная часть обновлена \(abc1234\)/)
  assert.match(dom, /серверную \(Python\) часть/)
  assert.match(dom, /Возможности → Плагины/)
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
})

test('update command follows a detected Windows server through the COMSPEC probe', async () => {
  const f = await fixture()
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  f.host.state.focusedSessionOwner = { get: () => ({ connectionId: 'srv', profile: 'default' }) }
  f.host.profileRoutes = async () => [{ connectionId: 'srv', profile: 'default' }]
  const commands = []
  const original = f.host.requestProfile
  f.host.requestProfile = async (route, method, params) => {
    if (method === 'shell.exec') {
      commands.push(params.command)
      return /%COMSPEC%/.test(params.command) ? { code: 0, stdout: 'C:\\Windows\\system32\\cmd.exe' } : { code: 0, stdout: 'deadbee\n' }
    }
    return original(route, method, params)
  }
  await findButton(f, 'Обновить плагин на сервере').props.onClick()
  for (let i = 0; i < 20 && !JSON.stringify(f.render()).includes('deadbee'); i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(commands, ['echo %COMSPEC%', f.mod.updateCommandFor(true)])
  assert.match(JSON.stringify(f.render()), /Серверная часть обновлена \(deadbee\)/)
})

test('failed server update shows a bounded reason without a raw stack', async () => {
  const f = await fixture()
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  const original = f.host.requestProfile
  f.host.requestProfile = async (route, method, params) => {
    if (method === 'shell.exec' && !/%COMSPEC%/.test(params.command)) {
      return { code: 128, stdout: '', stderr: 'fatal: cannot lock ref\n    at Object.<anonymous> (git.js:1:1)\n    at process (node.js:1:1)' }
    }
    return original(route, method, params)
  }
  await findButton(f, 'Обновить плагин на сервере').props.onClick()
  for (let i = 0; i < 20 && !JSON.stringify(f.render()).includes('Не удалось'); i++) await new Promise(resolve => setImmediate(resolve))
  const dom = JSON.stringify(f.render())
  assert.match(dom, /Не удалось обновить серверную часть/)
  assert.match(dom, /fatal: cannot lock ref/)
  assert.doesNotMatch(dom, /at Object|at process/)
  assert.ok(findButton(f, 'Обновить плагин на сервере'))
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
})

test('gateway that rejects an extra session_id still updates via the command alone', async () => {
  const f = await fixture()
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  const attempts = []
  const original = f.host.requestProfile
  f.host.requestProfile = async (route, method, params, timeoutMs) => {
    if (method === 'shell.exec' && !/%COMSPEC%/.test(params.command)) {
      attempts.push({ session_id: params.session_id, timeoutMs })
      if (params.session_id != null) throw Error('invalid params for shell.exec: session_id: Extra inputs are not permitted')
      return { code: 0, stdout: 'abc1234\n' }
    }
    return original(route, method, params, timeoutMs)
  }
  await findButton(f, 'Обновить плагин на сервере').props.onClick()
  for (let i = 0; i < 20 && !JSON.stringify(f.render()).includes('abc1234'); i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attempts, [{ session_id: undefined, timeoutMs: 40000 }])
  assert.match(JSON.stringify(f.render()), /Серверная часть обновлена \(abc1234\)/)
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
})

test('gateway that requires session_id gets the focused runtime id on the bounded retry', async () => {
  const f = await fixture()
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  const attempts = []
  const original = f.host.requestProfile
  f.host.requestProfile = async (route, method, params, timeoutMs) => {
    if (method === 'shell.exec' && !/%COMSPEC%/.test(params.command)) {
      attempts.push(params.session_id ?? null)
      if (params.session_id == null) throw Error('invalid params for shell.exec: session_id: Field required')
      return { code: 0, stdout: 'deadbee\n' }
    }
    return original(route, method, params, timeoutMs)
  }
  await findButton(f, 'Обновить плагин на сервере').props.onClick()
  for (let i = 0; i < 20 && !JSON.stringify(f.render()).includes('deadbee'); i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(attempts, [null, 'runtime-old'])
  assert.match(JSON.stringify(f.render()), /Серверная часть обновлена \(deadbee\)/)
})

test('session_id adaptation stays bounded at three attempts with one honest line', async () => {
  const f = await fixture()
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  let attempts = 0
  const original = f.host.requestProfile
  f.host.requestProfile = async (route, method, params) => {
    if (method === 'shell.exec' && !/%COMSPEC%/.test(params.command)) {
      attempts++
      const why = params.session_id != null ? 'Extra inputs are not permitted' : 'Field required'
      throw Error(`invalid params for shell.exec: session_id: ${why}`)
    }
    return original(route, method, params)
  }
  await findButton(f, 'Обновить плагин на сервере').props.onClick()
  for (let i = 0; i < 20 && !JSON.stringify(f.render()).includes('Не удалось'); i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(attempts, 3)
  const dom = JSON.stringify(f.render())
  assert.match(dom, /Не удалось обновить серверную часть/)
  assert.match(dom, /invalid params for shell\.exec: session_id: Field required/)
  assert.doesNotMatch(dom, /at Object|at process|at async/)
  assert.equal(dom.includes('\\n'), false)
  assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
})
