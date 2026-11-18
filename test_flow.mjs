import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

async function fixture() {
  const calls = [], events = new Map(), contributions = [], storage = new Map()
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
  mod.default.register({ storage: { get: (k, d) => storage.get(k) ?? d, set: (k, v) => storage.set(k, v) }, register: c => contributions.push(c), onDispose() {} })
  const render = () => { index = 0; return contributions[0].render().type() }
  const fire = payload => events.get('plugin.session-handoff-review.prepare')({ payload })
  const payload = () => ({ oldId: 'old', oldTitle: 'Старый чат', profile: 'default', title: 'Старый чат 2', handoff: 'Проверено: файл. Далее: тест.', requestId: calls.find(c => c[0] === 'composer.submit')?.[2].match(/Идентификатор заявки: ([a-f0-9-]+)/)?.[1] })
  return { host, calls, rows, render, fire, payload, mod, setAccepted: v => { accepted = v }, setTranscript: v => { transcript = v }, setFocus: v => { focused = v }, setBusy: v => { busy = v }, setOpened: v => { opened = v } }
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
  assert.match(chip.props.children, /Начался переезд.*Стоп/)
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
