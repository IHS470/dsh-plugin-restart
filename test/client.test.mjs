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
    /** Just enough React for a section to register: the component itself is never rendered here. */
    const REACT_SHIM = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
    }

function boot(fetchImpl, { overlayVisible = true, slots } = {}) {
  let captured = null
  const windowStub = {
    innerWidth: 1280,
    closed: false,
    close() { this.closed = true },
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, module: factory((name) => {
            if (name === 'react') return REACT_SHIM
            throw new Error(`unexpected require(${name})`)
          }) }
      },
    },
  }
  const body = makeElement('body')
  const rootStyle = { values: {}, setProperty(name, value) { this.values[name] = value } }
  const head = makeElement('head')
  // The document keeps its listeners, so the harness can drive the real keydown handler.
  const documentListeners = new Map()
  const documentStub = {
    documentElement: { getAttribute: () => 'zh', setAttribute() {}, removeAttribute() {}, style: rootStyle },
    head,
    body,
    createElement: (type) => makeElement(type),
    addEventListener(name, handler) { documentListeners.set(name, handler) },
    removeEventListener(name) { documentListeners.delete(name) },
    dispatch(name, event) { documentListeners.get(name)?.(event ?? {}) },
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
  captured.module.apply({
      effect: (fn) => { disposers.push(fn()) },
      ...(slots === undefined ? {} : { slots }),
    })
  return { module: captured.module, body, head, overlay, rootStyle, windowStub, disposers, document: documentStub }
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
// The Settings section is a slot entry, so the slot service has to be declared: without it ctx.slots is
    // undefined and the registration is skipped — which is exactly how 0.5.0 shipped with no Settings section.
    assert.deepEqual(a.module.inject, ['slots'], 'the slot service is declared for the Settings section')
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
assert.equal(requests.filter((entry) => entry.url === '/dsh-restart/state').length, 1, 'and asks the Host whether a restart is possible')
    assert.equal(requests.filter((entry) => entry.url === '/dsh-restart/ready').length, 1, 'while announcing that this page has mounted — the helper shows the window only after that')
    assert.equal(requests.length, 2, 'which is everything mounting asks for')
assert.ok(requests.some((entry) => entry.url === '/dsh-restart/state'), 'the capability request is among them')

cancelButton(a).dispatch('click')
await flush()
assert.equal(popover(a).hidden, true, 'cancel closes it')
assert.equal(requests.filter((entry) => entry.url === '/dsh-restart/restart').length, 0, 'and no restart was asked of the Host')
console.log('A cancel: popover closed with no restart request')

    // --- case A2: the Settings section is really registered ----------------------
    //
    // 0.5.0 shipped with the section silently missing: the guard that keeps a missing React from breaking the
    // caption button also swallowed a missing slot service, and nothing asserted the registration. This does.

    const registrations = []
    const slotsStub = {
      inject: (name, factory) => { factory() },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    }
    boot(serveState, { slots: slotsStub })
    assert.equal(registrations.length, 1, 'the Settings section is registered when the slot service is available')
    assert.equal(registrations[0].options.name, 'settings.section', 'into the Settings page')
    assert.equal(registrations[0].options.id, 'dsh-restart', 'under its own id')
    assert.equal(typeof registrations[0].component, 'function', 'with a component to render')
    console.log('A2 settings section registered as', registrations[0].options.id, '| order', registrations[0].options.order)

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

// If the app never goes away, this page is still here to say so — a notice that spins forever is
// worse than one that admits it. The popover's own auto-close must not win either race.
await new Promise((resolve) => setTimeout(resolve, 5300))
assert.equal(note(c).textContent, '重启似乎没有生效，请再试一次或手动重启', 'a restart that does not take effect says so')
assert.equal(popover(c).hidden, false, 'and the popover is still there to read it in')
await new Promise((resolve) => setTimeout(resolve, 3400))
assert.equal(popover(c).hidden, false, 'and it stays up past the popover timeout')
console.log('C restart accepted: window closed =', c.windowStub.closed, '| after the watchdog:', note(c).textContent)

// --- case D: a restart that is already in flight ----------------------------

const d = boot(async (url) => (
  String(url).endsWith('/restart')
    ? { ok: true, json: async () => ({ ok: false, code: 'busy' }) }
    : { ok: true, json: async () => ({ restart: { available: true } }) }
))
chromeButton(d).dispatch('click')
await flush()
goButton(d).dispatch('click')
await flush()
assert.equal(note(d).textContent, '已经在重启了，请稍候…', 'a second click in the same window is told, not silently dropped')
assert.equal(goButton(d).disabled, false, 'and the button is usable again')
console.log('D busy case:', note(d).textContent)

// --- case D2: a restart that is only waiting out the app's boot ---------------

const d2 = boot(async (url) => (
  String(url).endsWith('/restart')
    ? { ok: true, json: async () => ({ ok: false, code: 'settling', retryInMs: 4300 }) }
    : { ok: true, json: async () => ({ restart: { available: true } }) }
))
chromeButton(d2).dispatch('click')
await flush()
goButton(d2).dispatch('click')
await flush()
assert.match(note(d2).textContent, /刚重启过/, 'a click while the app is still starting says so')
assert.match(note(d2).textContent, /5 秒/, 'and counts the wait the host reported (4300ms up to 5s)')
assert.equal(goButton(d2).disabled, false, 'the button stays usable for the retry')
console.log('D2 settling case:', note(d2).textContent)

// --- case E: keyboard ---------------------------------------------------------

const e = boot(serveState)
chromeButton(e).dispatch('click')
await flush()
assert.equal(popover(e).hidden, false, 'the popover is open for the keyboard case')
e.document.dispatch('keydown', { key: 'Enter', target: { tagName: 'INPUT' } })
await flush()
assert.equal(popover(e).hidden, false, 'Enter while typing in a prompt never restarts the app')
assert.equal(requests.filter((entry) => entry.url === '/dsh-restart/restart').length, 0, 'no restart was requested')

const posted = []
const f = boot(async (url, init) => {
  if (String(url).endsWith('/restart')) {
    posted.push(init?.method)
    return { ok: true, json: async () => ({ ok: true, mode: 'relaunch' }) }
  }
  return { ok: true, json: async () => ({ restart: { available: true } }) }
})
chromeButton(f).dispatch('click')
await flush()
f.document.dispatch('keydown', { key: 'Enter', target: { tagName: 'BUTTON' } })
await flush()
assert.deepEqual(posted, ['POST'], 'Enter in the popover confirms the restart')
console.log('E keyboard: Enter confirms, and is ignored while typing')

// --- case F: no caption band (full screen), and disposal --------------------

const g = boot(serveState, { overlayVisible: false })
assert.equal(chromeButton(g), undefined, 'a window whose overlay reports no visible band gets no button')
console.log('F full screen: nothing mounted')

const h = boot(serveState)
const button = chromeButton(h)
const panel = popover(h)
assert.equal(h.disposers.length, 1, 'apply registers one effect')
for (const dispose of h.disposers) dispose()
assert.equal(button.isConnected, false, 'disposal removes the button')
assert.equal(panel.isConnected, false, 'disposal removes the popover')
console.log('G dispose: chrome removed')

console.log('\nRESULT: dsh-plugin-restart browser half mounts in the caption band, confirms before restarting,')
console.log('        reports a restart that is already running or did not take effect, and never closes its window')
process.exit(0)
