/**
 * Browser-half harness for dsh-plugin-restart.
 *
 * Loads `client.js` with stubbed window/document/navigator/fetch and checks the whole promise of
 * the button: it mounts into the caption band beside the native window buttons, its geometry
 * comes from the live caption-overlay rectangle, one click only arms it, cancelling asks the Host
 * for nothing, and confirming asks exactly once — while deliberately never closing the window,
 * because the desktop shell turns a window close into "hide the app in the tray".
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal element double: enough for the injected window-chrome button. */
function makeElement(type) {
  const classes = new Set()
  const listeners = new Map()
  return {
    type,
    className: '',
    innerHTML: '',
    title: '',
    hidden: false,
    disabled: false,
    isConnected: true,
    attributes: {},
    style: { values: {}, setProperty(name, value) { this.values[name] = value } },
    classList: {
      add: (name) => { classes.add(name) },
      remove: (name) => { classes.delete(name) },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force
        if (on) classes.add(name)
        else classes.delete(name)
      },
    },
    setAttribute(name, value) { this.attributes[name] = value },
    addEventListener(name, handler) { listeners.set(name, handler) },
    removeEventListener(name) { listeners.delete(name) },
    children: [],
    append(...nodes) {
      this.children.push(...nodes)
      this.appended = this.children[0]
    },
    contains(node) { return this.children.includes(node) },
    remove() { this.isConnected = false },
    dispatch(name, event) { listeners.get(name)?.(event ?? {}) },
    classNames() { return [...classes] },
  }
}

/** Load the browser half once, with its own module state. */
function boot(fetchImpl, { overlayVisible = true } = {}) {
  let captured = null
  const windowStub = {
    innerWidth: 1280,
    closed: false,
    close() { this.closed = true },
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, module: factory((name) => { throw new Error(`unexpected require(${name})`) }) }
      },
    },
  }
  const body = makeElement('body')
  const rootStyle = { values: {}, setProperty(name, value) { this.values[name] = value } }
  const head = makeElement('head')
  const documentStub = {
    documentElement: { getAttribute: () => 'zh', setAttribute() {}, removeAttribute() {}, style: rootStyle },
    head,
    body,
    createElement: (type) => makeElement(type),
    addEventListener() {},
    removeEventListener() {},
  }
  const overlay = {
    visible: overlayVisible,
    getTitlebarAreaRect: () => ({ right: windowStub.innerWidth - 138, width: 1142 }),
    addEventListener() {},
    removeEventListener() {},
  }
  const navigatorStub = { language: 'zh-CN', windowControlsOverlay: overlay }

  new Function('window', 'document', 'navigator', 'fetch', 'console', 'getComputedStyle', code)(
    windowStub, documentStub, navigatorStub, fetchImpl, console,
    () => ({ getPropertyValue: () => '40px' }),
  )
  assert.ok(captured, 'client.js did not call __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-plugin-restart')

  const disposers = []
  captured.module.apply({ effect: (fn) => { disposers.push(fn()) } })
  return { module: captured.module, body, head, overlay, rootStyle, windowStub, disposers }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))
const chromeButton = (booted) => booted.body.children.find((child) => child.className === 'dsh-restart-button')
const popover = (booted) => booted.body.children.find((child) => child.className === 'dsh-restart-panel')
const goButton = (booted) => popover(booted).children[3].children[1]
const cancelButton = (booted) => popover(booted).children[3].children[0]
const note = (booted) => popover(booted).children[2]

// --- case A: mount, geometry, cancel ----------------------------------------

const requests = []
const serveState = async (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET' })
  return { ok: true, json: async () => ({ restart: { available: true } }) }
}

const a = boot(serveState)
assert.equal(typeof a.module.apply, 'function', 'client half exports apply')
assert.deepEqual(a.module.inject, [], 'nothing is injected: the button is chrome, not a slot entry')
assert.ok(chromeButton(a), 'the restart button mounts into the window chrome')
assert.ok(popover(a), 'and brings its confirm popover')
assert.equal(popover(a).hidden, true, 'the popover starts closed')
assert.equal(chromeButton(a).style.values['--dsh-restart-right'], undefined, 'geometry rides on the root, not the button')
assert.equal(a.rootStyle.values['--dsh-restart-right'], '142px', 'sits clear of the three caption buttons')
assert.equal(a.rootStyle.values['--dsh-restart-height'], '40px', 'matches the reserved caption band')
assert.ok(a.head.children.some((child) => child.id === 'dsh-plugin-restart-style'), 'the stylesheet is installed once')
console.log('A mounts at right =', a.rootStyle.values['--dsh-restart-right'], '| band =', a.rootStyle.values['--dsh-restart-height'])

chromeButton(a).dispatch('click')
await flush()
assert.equal(popover(a).hidden, false, 'the first click arms it visibly')
assert.equal(requests.length, 1, 'and asks the Host whether a restart is possible')
assert.equal(requests[0].url, '/dsh-restart/state')

cancelButton(a).dispatch('click')
await flush()
assert.equal(popover(a).hidden, true, 'cancel closes it')
assert.equal(requests.filter((entry) => entry.method === 'POST').length, 0, 'and nothing was asked of the Host')
console.log('A cancel: popover closed with no restart request')

// --- case B: a Host that has no desktop shell -------------------------------

const b = boot(async (url) => (
  String(url).endsWith('/state')
    ? { ok: true, json: async () => ({ restart: { available: false, detail: 'no-desktop-shell' } }) }
    : { ok: true, json: async () => ({ ok: true }) }
))
chromeButton(b).dispatch('click')
await flush()
assert.equal(note(b).textContent, '重启能力还没加载：请先重启一次应用', 'the popover explains why, instead of only a tooltip')
assert.equal(goButton(b).disabled, false, 'the button can still be tried again')
console.log('B no-shell case:', note(b).textContent)

// --- case C: a Host that accepts the restart --------------------------------

const accepted = []
const c = boot(async (url, init) => {
  if (String(url).endsWith('/restart')) {
    accepted.push({ url: String(url), method: init?.method })
    return { ok: true, json: async () => ({ ok: true, mode: 'relaunch' }) }
  }
  return { ok: true, json: async () => ({ restart: { available: true } }) }
})
chromeButton(c).dispatch('click')
await flush()
goButton(c).dispatch('click')
await flush()
assert.equal(accepted.length, 1, 'the restart was requested')
assert.equal(accepted[0].url, '/dsh-restart/restart')
assert.equal(accepted[0].method, 'POST', 'through the restart route')
assert.equal(note(c).textContent, '正在重启…', 'and the popover says so while it happens')
await flush()
assert.equal(c.windowStub.closed, false, 'the window is never closed: the desktop shell turns a close into "hide in the tray" and it releases nothing')
assert.equal(popover(c).hidden, false, 'so the restart notice stays on screen')
// The popover has an auto-close timer; a restart must outlive it, because this line is the only
// feedback the user gets while the app is going away.
await new Promise((resolve) => setTimeout(resolve, 8300))
assert.equal(popover(c).hidden, false, 'and it stays up past the popover timeout')
assert.equal(note(c).textContent, '正在重启…', 'still saying what is happening')
console.log('C restart accepted: popover says', note(c).textContent, '| window closed =', c.windowStub.closed, '| popover still open =', !popover(c).hidden)

// --- case D: no caption band (full screen), and disposal --------------------

const d = boot(serveState, { overlayVisible: false })
assert.equal(chromeButton(d), undefined, 'a window whose overlay reports no visible band gets no button')
console.log('D full screen: nothing mounted')

const e = boot(serveState)
const button = chromeButton(e)
const panel = popover(e)
assert.equal(e.disposers.length, 1, 'apply registers one effect')
for (const dispose of e.disposers) dispose()
assert.equal(button.isConnected, false, 'disposal removes the button')
assert.equal(panel.isConnected, false, 'disposal removes the popover')
console.log('E dispose: chrome removed')

console.log('\nRESULT: dsh-plugin-restart browser half mounts in the caption band, confirms before restarting, and never closes its window')
process.exit(0)
