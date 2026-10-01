/**
 * Host-half harness for dsh-plugin-restart.
 *
 * Mounts the plugin against a stub context and drives its routes directly: what the browser is
 * told about the capability, that a host without a desktop shell refuses instead of pretending
 * it restarted something, and that the trust fence turns away everyone except this window's own
 * same-origin loopback request.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The plugin reads DSH_HOME at load time, so it has to be set before the import below.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-plugin-restart-'))

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

/** Mount the plugin with a stub web server, optionally with a connection guard. */
function mount(connection) {
  let handler = null
  const ctx = {
    effect: (fn) => { fn() },
    webServer: {
      register: ({ path, handler: registered }) => {
        assert.equal(path, '/dsh-restart', 'routes live under the plugin prefix')
        handler = registered
        return () => {}
      },
    },
    get: (key) => (key === 'connection' ? connection : undefined),
  }
  mod.apply(ctx)
  assert.ok(handler, 'the plugin registered a route handler')
  return handler
}

function makeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:19387', ...headers },
  }
}

function makeRes() {
  return {
    status: 0,
    raw: '',
    writeHead(status) { this.status = status },
    end(chunk) { if (chunk !== undefined) this.raw += chunk.toString() },
  }
}

async function call(handler, req) {
  const res = makeRes()
  await handler(req, res)
  return { status: res.status, json: res.raw === '' ? undefined : JSON.parse(res.raw) }
}

assert.equal(mod.name, 'restart', 'the plugin names itself')
assert.deepEqual(mod.inject, ['webServer'], 'it injects the web server')

// --- 1. the capability is probed, never assumed -----------------------------

const handler = mount(undefined)

const state = await call(handler, makeReq({ url: '/dsh-restart/state' }))
assert.equal(state.status, 200, 'state answers')
assert.equal(state.json.restart.available, false, 'a plain node host (this test) has no desktop shell to restart')
assert.ok(
  ['no-desktop-shell', 'unsupported-platform'].includes(state.json.restart.detail),
  `and says why: ${state.json.restart.detail}`,
)
console.log('1 state:', JSON.stringify(state.json))

// --- 2. a host that cannot restart says so ----------------------------------

const restart = await call(handler, makeReq({ method: 'POST', url: '/dsh-restart/restart' }))
assert.equal(restart.status, 200, 'the restart route answers the browser instead of failing it')
assert.deepEqual(restart.json, { ok: false, code: 'unavailable' }, 'and refuses to pretend it restarted')
console.log('2 restart route:', JSON.stringify(restart.json))

// --- 3. the trust fence -----------------------------------------------------

const foreign = await call(handler, makeReq({
  method: 'POST',
  url: '/dsh-restart/restart',
  headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
}))
assert.equal(foreign.status, 403, 'a cross-site caller is refused')

const foreignOrigin = await call(handler, makeReq({
  method: 'POST',
  url: '/dsh-restart/restart',
  headers: { origin: 'https://evil.example' },
}))
assert.equal(foreignOrigin.status, 403, 'a foreign Origin is refused')

const remoteHost = await call(handler, makeReq({ url: '/dsh-restart/state', headers: { host: 'example.com' } }))
assert.equal(remoteHost.status, 403, 'a non-loopback authority is refused when no guard is present')

const sameOrigin = await call(handler, makeReq({
  url: '/dsh-restart/state',
  headers: { origin: 'http://127.0.0.1:19387' },
}))
assert.equal(sameOrigin.status, 200, 'this window (matching Origin) is served')
console.log('3 trust fence: cross-site 403, foreign origin 403, remote host 403, same origin 200')

// The Host's own guard, when there is one, is authoritative.
const rejecting = mount({ requestRejection: () => 403 })
assert.equal(
  (await call(rejecting, makeReq({ url: '/dsh-restart/state' }))).status,
  403,
  'the Host connection guard can refuse a request the fence alone would allow',
)
const allowing = mount({ requestRejection: () => null })
assert.equal(
  (await call(allowing, makeReq({ url: '/dsh-restart/state', headers: { host: 'example.com' } }))).status,
  200,
  'and its approval is what decides, loopback or not',
)
console.log('3b connection guard: reject → 403, allow → 200')

// --- 4. unknown paths -------------------------------------------------------

const missing = await call(handler, makeReq({ url: '/dsh-restart/nope' }))
assert.equal(missing.status, 404, 'an unknown path is a plain 404')

const wrongMethod = await call(handler, makeReq({ method: 'GET', url: '/dsh-restart/restart' }))
assert.equal(wrongMethod.status, 404, 'restarting is a POST, and a GET is not one')
console.log('4 unknown path 404, GET /restart 404')

console.log('\nRESULT: dsh-plugin-restart host half answers the capability, refuses what it cannot do, and fences foreign callers')
process.exit(0)
