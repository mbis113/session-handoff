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

async function approve(f) {
  await f.render().props.onOpenChange(true)
  await new Promise(resolve => setImmediate(resolve))
  const tree = f.render()
  const children = tree.props.children[1].props.children.props.children
  const input = children.find(c => c?.type === 'Input')
  input.props.onChange({ target: { value: 'Старый чат 2' } })
  const button = f.render().props.children[1].props.children.props.children.at(-1).props.children.at(-1)
  await button.props.onClick()
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
  const button = f.render().props.children[1].props.children.props.children.at(-1).props.children.at(-1)
  await button.props.onClick()
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
  const button = f.render().props.children[1].props.children.props.children.at(-1).props.children.at(-1)
  await button.props.onClick()
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

test('failed request with a local write latch or existing title cannot enable retry', async () => {
  for (const condition of ['latch', 'title']) {
    const mailbox = new Map([['failed-old', { requestId: 'failed-old', profile: 'default', oldId: 'old', oldTitle: 'Старый чат', title: 'Старый чат 2', status: 'failed', newId: null }]])
    const storage = new Map([['lastRequest', { requestId: 'failed-old', profile: 'default' }]])
    if (condition === 'latch') storage.set('handoff:default:old', { token: 'failed-old', status: 'pending' })
    const f = await fixture({ mailbox, storage })
    if (condition === 'title') f.rows.push({ id: 'partial', title: 'Старый чат 2', source: 'desktop', profile: 'default', archived: false, pinned: false })
    await f.mod.refreshStatus()
    assert.match(JSON.stringify(f.render()), /Переезд остановлен/)
    assert.equal(f.calls.some(c => c[0] === 'composer.submit' || c[0] === 'session.create'), false)
  }
})
