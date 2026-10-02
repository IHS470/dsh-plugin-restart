/**
 * dsh-plugin-restart — browser half.
 *
 * One job: a restart button in the window's caption band, just left of the native minimize /
 * maximize / close buttons, with a visible confirmation popover. Confirming asks the Host to
 * restart the app; this window is deliberately left open, because the desktop shell answers a
 * window close by hiding the app in the tray — and because the single-instance lock belongs to
 * the process, not the window, so closing it would release nothing.
 *
 * The band this button lives in is the Windows caption overlay (`titleBarOverlay`). No slot owns
 * it, so the button is plain DOM positioned from the overlay's own rectangle, which keeps it
 * clear of the native buttons at any DPI. A window whose overlay reports itself invisible (full
 * screen) gets no button, because the band is gone with it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-restart',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    /**
     * React, if this page's loader offers it.
     *
     * Only the Settings section needs it, and the caption-band button must never depend on it: when
     * `require('react')` is unavailable the section is simply not registered and everything else behaves
     * exactly as it did before.
     */
    let React
    try {
      React = require('react')
    } catch {
      React = undefined
    }
    const h = React === undefined ? undefined : React.createElement

    /** The settings in force, once they have been read; the chrome reads this to place itself. */
    let chromeStateRequest
    let chromeSettings
    /** How the mounted chrome re-places or removes itself when a setting changes. */
    const chrome = { reposition: () => {}, unmount: () => {} }
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const PREFIX = '/dsh-restart'
    const STYLE_ID = 'dsh-plugin-restart-style'
    /** How long the confirm popover stays open by itself. */
    const POPOVER_MS = 8000
    /**
     * How long to wait for the app to actually go away before admitting it did not. The window is
     * torn down with the old process, so a page that is still here after this long was never
     * restarted — and saying so beats a notice that spins forever.
     */
    const STALL_MS = 5000

    const zh = {
      title: '重启 DeepSeek Harness',
      hint: '会重新启动应用；正在运行的回合会中断。',
      go: '重启',
      cancel: '取消',
      pending: '正在重启…',
      busy: '已经在重启了，请稍候…',
      settingsTitle: '重启',
      settingsIntro: '关闭应用并重新启动它。',
      settingsQuit: '退出方式',
      quitGraceful: '正常退出（推荐）',
      quitForce: '强制退出',
      quitGracefulHint: '先让 Host 自己干净退出，再关壳，然后给整代进程最多 10 秒自己退干净；赖着不走的才补杀，日志里记 escalated=true。',
      quitForceHint: '一次性把整棵进程树关掉：最快，但托盘图标可能留到鼠标划过（Windows 的幽灵图标）。',
      settingsButton: '按钮位置',
      buttonRight: '标题栏右侧',
      buttonLeft: '标题栏左侧',
      buttonSettings: '只在设置里',
      settingsOffset: '按钮偏移（像素）',
      settingsOffsetHint: '两侧都可用：正数远离窗口角落，负数靠近。',
      settingsWindow: '窗口核验',
      windowAuto: '自动（缺窗口才抬）',
      windowAlways: '每次都抬',
      windowReport: '只报告',
      settingsSettle: '稳定等待（秒）',
      settingsSettleHint: '应用起来后锁握多久，防止紧接着的第二次重启把它杀在启动中。',
      restartNow: '立即重启',
      settingsLoading: '正在读取设置…',
      restarted: '已请求重启。',
      settling: '刚重启过：应用还在启动，请等它起来再试。',
      settlingSoon: '刚重启过：应用还在启动，约 {n} 秒后再试。',
      stalled: '重启似乎没有生效，请再试一次或手动重启',
      unavailable: '重启能力还没加载：请先重启一次应用',
      failed: '重启失败，请手动重启',
    }

    const en = {
      title: 'Restart DeepSeek Harness',
      hint: 'Restarts the app; a running turn is interrupted.',
      go: 'Restart',
      cancel: 'Cancel',
      pending: 'Restarting…',
      busy: 'A restart is already in progress…',
      settingsTitle: 'Restart',
      settingsIntro: 'Close this application and start it again.',
      settingsQuit: 'How it quits',
      quitGraceful: 'Graceful (recommended)',
      quitForce: 'Force',
      quitGracefulHint: 'The host exits cleanly, then the shell closes, then the whole generation gets up to ten seconds to leave on its own; only what refuses is closed, and the log records escalated=true.',
      quitForceHint: 'Closes the whole process tree at once: fastest, but Windows may keep a ghost tray icon until the pointer passes over it.',
      settingsButton: 'Button position',
      buttonRight: 'Right of the caption',
      buttonLeft: 'Left of the caption',
      buttonSettings: 'Settings only',
      settingsOffset: 'Button offset (px)',
      settingsOffsetHint: 'Either side: positive moves it away from the window corner, negative towards it.',
      settingsWindow: 'Window check',
      windowAuto: 'Automatic (raise only when missing)',
      windowAlways: 'Always raise',
      windowReport: 'Report only',
      settingsSettle: 'Settle (seconds)',
      settingsSettleHint: 'How long the lock is held after the app is up, so a second click cannot kill it mid-boot.',
      restartNow: 'Restart now',
      settingsLoading: 'Reading settings…',
      restarted: 'Restart requested.',
      settling: 'Just restarted: the app is still starting — try again once it is up.',
      settlingSoon: 'Just restarted: the app is still starting — try again in about {n}s.',
      stalled: 'The restart did not take effect — try again or restart manually',
      unavailable: 'Restart is not loaded yet: restart the app once',
      failed: 'Restart failed — restart manually',
    }

    function copy() {
      const lang = (document.documentElement && document.documentElement.getAttribute('lang')) || navigator.language || ''
      return lang.toLowerCase().startsWith('zh') ? zh : en
    }

    /**
     * What to say when the host is only waiting out the app's boot.
     *
     * The host knows how much of that wait is left, so the message counts it down in whole seconds
     * instead of leaving the user to guess whether the button is broken.
     */
    function settlingText(retryInMs) {
      const text = copy()
      const seconds = Number(retryInMs)
      if (!Number.isFinite(seconds) || seconds <= 0) return text.settling
      return text.settlingSoon.replace('{n}', String(Math.max(1, Math.ceil(seconds / 1000))))
    }

    async function request(path, init) {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    const STYLE_SHEET = `
/* Restart, in the reserved caption band immediately left of the native window buttons.
 * The right offset and the height come from the live caption-overlay rectangle. */
.dsh-restart-button {
  position: fixed;
  top: 0;
  right: var(--dsh-restart-right, 142px);
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: var(--dsh-restart-height, 40px);
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit;
  cursor: default;
  -webkit-app-region: no-drag;
}
.dsh-restart-button:hover {
  background: rgba(127, 127, 127, 0.18);
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-restart-button.is-open {
  background: rgba(127, 127, 127, 0.18);
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-restart-button svg { display: block; width: 15px; height: 15px; }
/* The confirmation has to be a visible thing: an armed tint alone reads as no response. */
.dsh-restart-panel {
  position: fixed;
  top: calc(var(--dsh-restart-height, 40px) + 6px);
  right: var(--dsh-restart-right, 142px);
  z-index: 2147483000;
  box-sizing: border-box;
  width: 240px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35));
  border-radius: 10px;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  line-height: 1.5;
}
.dsh-restart-title { margin: 0; font-weight: 600; }
.dsh-restart-hint { margin: 4px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dsh-restart-note { margin: 8px 0 0; font-size: 12px; color: #d4484c; }
.dsh-restart-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.dsh-restart-actions button {
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35));
  border-radius: 6px;
  padding: 4px 12px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-restart-go { border-color: #e5484d; background: #e5484d; color: #ffffff; }
.dsh-restart-go:disabled { opacity: 0.5; cursor: default; }
.dsh-restart-cancel:hover { background: rgba(127, 127, 127, 0.14); }
`

    let styleElement = null

    function ensureStyle() {
      if (styleElement && styleElement.isConnected) return
      styleElement = document.createElement('style')
      styleElement.id = STYLE_ID
      styleElement.textContent = STYLE_SHEET
      document.head.append(styleElement)
    }

    /**
     * The button and its popover, mounted into the caption band.
     * @returns A disposer that removes both and every listener they added.
     */
    function mountRestartButton() {
      const overlay = navigator.windowControlsOverlay
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-restart-button'
      button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
        + '<path d="M13.4 8a5.4 5.4 0 1 1-1.58-3.83" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>'
        + '<path d="M13.4 2.5v3.1h-3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>'
        + '</svg>'

      const panel = document.createElement('div')
      panel.className = 'dsh-restart-panel'
      panel.setAttribute('role', 'dialog')
      panel.hidden = true
      const title = document.createElement('p')
      title.className = 'dsh-restart-title'
      const hint = document.createElement('p')
      hint.className = 'dsh-restart-hint'
      const note = document.createElement('p')
      note.className = 'dsh-restart-note'
      note.hidden = true
      const actions = document.createElement('div')
      actions.className = 'dsh-restart-actions'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'dsh-restart-cancel'
      const go = document.createElement('button')
      go.type = 'button'
      go.className = 'dsh-restart-go'
      actions.append(cancel, go)
      panel.append(title, hint, note, actions)

      let open = false
      let busy = false
      let ready
      let closeTimer
      let stallTimer

      function paint() {
        const text = copy()
        button.title = text.title
        button.setAttribute('aria-label', text.title)
        button.setAttribute('aria-expanded', open ? 'true' : 'false')
        button.classList.toggle('is-open', open)
        title.textContent = text.title
        hint.textContent = text.hint
        go.textContent = text.go
        cancel.textContent = text.cancel
        go.disabled = busy
        cancel.disabled = busy
      }

      /** Keep clear of the caption buttons, and match the band the frame reserves. */
      placeChrome = place

      function place() {
        let right = 138
          let left = 12
          if (overlay && typeof overlay.getTitlebarAreaRect === 'function') {
            const rect = overlay.getTitlebarAreaRect()
            if (rect && rect.width > 0) {
              right = Math.max(0, Math.round(window.innerWidth - rect.right))
              left = Math.max(0, Math.round(Number(rect.left) || 0))
            }
          }
          // Where the user asked for the button: either side of the caption band, moved by their offset. The
          // left side is expressed through the same `right` the stylesheet already uses, so no stylesheet has
          // to know about it: put the button's left edge at `left`, which is that far from the right once the
          // button's own width is subtracted. Width comes from the mounted button, defaulting to the sheet's.
          const wanted = chromeSettings ?? {}
          const offset = Number.isFinite(Number(wanted.offset)) ? Math.round(Number(wanted.offset)) : 0
          const root = document.documentElement.style
          if (wanted.button === 'left') {
            const width = Math.round(Number(button.getBoundingClientRect?.().width) || 34)
            root.setProperty('--dsh-restart-right', `${Math.max(8, window.innerWidth - left - offset - width)}px`)
          } else {
            root.setProperty('--dsh-restart-right', `${right + 4 + offset}px`)
          }
        const line = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height'),
        )
        if (Number.isFinite(line) && line > 0) root.setProperty('--dsh-restart-height', `${line}px`)
        // Full screen drops the overlay, so the band this button lives in is gone with it.
        const gone = overlay !== undefined && overlay.visible === false
        button.hidden = gone
        if (gone) close()
      }

      function say(text) {
        note.textContent = text
        note.hidden = false
      }

      function close() {
        open = false
        panel.hidden = true
        clearTimeout(closeTimer)
        paint()
      }

      /** Ask the Host once whether there is a desktop shell to restart. */
      async function capability() {
        if (ready !== undefined) return ready
        try {
          // The chrome already asked for this when it mounted; awaiting that answer avoids asking twice.
          const state = chromeStateRequest !== undefined ? await chromeStateRequest : await request(`${PREFIX}/state`)
          ready = !(state && state.restart) || state.restart.available === true
        } catch {
          ready = true   // let the click itself report a route that is not there
        }
        if (ready === false) say(copy().unavailable)
        paint()
        return ready
      }

      async function show() {
        open = true
        panel.hidden = false
        note.hidden = true
        paint()
        clearTimeout(closeTimer)
        closeTimer = setTimeout(close, POPOVER_MS)
        await capability()
      }

      async function restart() {
        busy = true
        // The app is on its way out: the confirmation must not time out under the user, because
        // this line is the only thing saying the click was heard.
        clearTimeout(closeTimer)
        clearTimeout(stallTimer)
        say(copy().pending)
        paint()
        try {
          const result = await request(`${PREFIX}/restart`, { method: 'POST' })
          if (result && result.ok === true) {
            say(copy().pending)
            // Deliberately no `window.close()` here. The desktop shell answers a window close by
            // hiding the app in the tray and staying alive, so closing it read as "the app went to
            // the tray" instead of "the app is restarting" — and it never released the
            // single-instance lock anyway, which belongs to the process, not the window. The Host
            // exits by itself, the detached helper starts the app again, and this window disappears
            // with the old process.
            //
            // If that does not happen, this page is still here to say so.
            stallTimer = setTimeout(() => {
              busy = false
              say(copy().stalled)
              paint()
            }, STALL_MS)
            return
          }
          busy = false
          if (result && result.code === 'unavailable') ready = false
          // `settling` is a restart that is over except for waiting out the app's boot: the honest
          // answer is "the app is starting, give it a moment", not "something is already running".
          if (result && result.code === 'busy') say(copy().busy)
          else if (result && result.code === 'settling') say(settlingText(result.retryInMs))
          else say(result && result.code === 'unavailable' ? copy().unavailable : copy().failed)
          paint()
        } catch (error) {
          busy = false
          const missing = error instanceof Error && error.message === 'HTTP 404'
          if (missing) ready = false
          say(missing ? copy().unavailable : copy().failed)
          paint()
        }
      }

      function onButton() {
        if (open) close()
        else void show()
      }

      function onGo() {
        if (!busy && ready !== false) void restart()
      }

      function onCancel() {
        close()
      }

      /** Escape closes; Enter confirms, but only from the popover — never while typing a prompt. */
      function onKey(event) {
        if (!open) return
        if (event.key === 'Escape') {
          close()
          return
        }
        if (event.key !== 'Enter') return
        const target = event.target
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
        event.preventDefault?.()
        onGo()
      }

      function onOutside(event) {
        if (!open) return
        if (event.target === button || panel.contains(event.target)) return
        close()
      }

      function onGeometry() {
        place()
      }

      button.addEventListener('click', onButton)
      go.addEventListener('click', onGo)
      cancel.addEventListener('click', onCancel)
      document.addEventListener('keydown', onKey, true)
      document.addEventListener('pointerdown', onOutside, true)
      window.addEventListener('resize', onGeometry)
      overlay?.addEventListener?.('geometrychange', onGeometry)
      document.body.append(button, panel)
      place()
      paint()

      return () => {
        clearTimeout(closeTimer)
        clearTimeout(stallTimer)
        button.removeEventListener('click', onButton)
        go.removeEventListener('click', onGo)
        cancel.removeEventListener('click', onCancel)
        document.removeEventListener('keydown', onKey, true)
        document.removeEventListener('pointerdown', onOutside, true)
        window.removeEventListener('resize', onGeometry)
        overlay?.removeEventListener?.('geometrychange', onGeometry)
        button.remove()
        panel.remove()
      }
    }

    /** One labelled control in the Settings section. */
    function row(label, hint, control) {
      return h('label', { className: 'dsh-restart-row' },
        h('span', { className: 'dsh-restart-row-title' }, label),
        hint === undefined ? null : h('span', { className: 'dsh-restart-row-hint' }, hint),
        control,
      )
    }

    /**
     * The restart, in the application's Settings — the same options the popover has, where a user looks for
     * them. Each change is sent on its own and the answer is the complete, validated settings object, so the
     * page always shows what the Host will actually run with.
     */
    function SettingsSection() {
      const [settings, setSettings] = React.useState(undefined)
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        let cancelled = false
        request(`${PREFIX}/state`)
          .then((state) => { if (!cancelled) setSettings(state.settings ?? {}) })
          .catch(() => { if (!cancelled) setNotice(copy().failed) })
        return () => { cancelled = true }
      }, [])

      const text = copy()
      if (settings === undefined) {
        return h('section', { className: 'dsh-restart-page' },
          h('h2', { className: 'dsh-restart-title' }, text.settingsTitle),
          h('p', { className: 'dsh-restart-note' }, text.settingsLoading),
        )
      }

      async function save(patch) {
        try {
          const next = await request(`${PREFIX}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          setSettings(next)
          setNotice(text.saved)
          // The caption button is another component and has to follow at once — and it disappears entirely
          // when the user asks for Settings-only.
          chromeSettings = next
          if (next.button === 'settings') chrome.unmount()
          else chrome.reposition()
        } catch {
          setNotice(text.failed)
        }
      }

      const choice = (value, options, patch) => h('select', {
        className: 'dsh-restart-select',
        value,
        onChange: (event) => void save(patch(event.target.value)),
      }, options.map(([key, label]) => h('option', { key, value: key }, label)))

      return h('section', { className: 'dsh-restart-page' },
        h('h2', { className: 'dsh-restart-title' }, text.settingsTitle),
        h('p', { className: 'dsh-restart-note' }, text.settingsIntro),
        row(text.settingsQuit, settings.quit === 'graceful' ? text.quitGracefulHint : text.quitForceHint,
          choice(settings.quit, [['graceful', text.quitGraceful], ['force', text.quitForce]], (value) => ({ quit: value }))),
        row(text.settingsButton, undefined,
          choice(settings.button, [['right', text.buttonRight], ['left', text.buttonLeft], ['settings', text.buttonSettings]], (value) => ({ button: value }))),
        row(text.settingsOffset, text.settingsOffsetHint,
          h('input', {
            className: 'dsh-restart-number',
            type: 'number',
            step: 2,
            value: settings.offset,
            onChange: (event) => void save({ offset: Number(event.target.value) }),
          })),
        row(text.settingsWindow, undefined,
          choice(settings.window, [['auto', text.windowAuto], ['always', text.windowAlways], ['report', text.windowReport]], (value) => ({ window: value }))),
        row(text.settingsSettle, text.settingsSettleHint,
          h('input', {
            className: 'dsh-restart-number',
            type: 'number',
            min: 0,
            step: 1,
            value: Math.round(Number(settings.settleMs ?? 0) / 1000),
            onChange: (event) => void save({ settleMs: Number(event.target.value) * 1000 }),
          })),
        h('div', { className: 'dsh-restart-actions' },
          h('button', {
            className: 'dsh-restart-action',
            type: 'button',
            onClick: async () => {
              try {
                const result = await request(`${PREFIX}/restart`, { method: 'POST' })
                setNotice(result && result.ok === false ? text.failed : text.restarted)
              } catch {
                setNotice(text.failed)
              }
            },
          }, text.restartNow),
          notice === '' ? null : h('span', { className: 'dsh-restart-note' }, notice),
        ),
      )
    }

    /** Re-run the mounted button's placement, if there is one. */
    let placeChrome = () => {}

    /**
     * The Settings section is a slot entry, so the slot service has to be declared here. Without it
     * `ctx.slots` is undefined, the registration below is skipped silently, and the restart never appears in
     * Settings — which is exactly what 0.5.0 shipped, because the guard that was meant to keep a missing
     * React from breaking anything also swallowed a missing slot service.
     */
    const inject = ['slots']

    function apply(ctx) {
        if (React !== undefined && h !== undefined && ctx.slots !== undefined) {
          // The Settings page, where a user looks for a restart; the caption button stays the quick way.
          ctx.slots.inject?.('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-restart',
            order: 64,
            label: () => copy().settingsTitle,
            inject: () => ({}),
          }, SettingsSection))
        }

        ctx.effect(() => {
        // Overlay windows only. A window whose overlay reports itself invisible has no caption
        // band to sit in (full screen), so nothing is mounted. A window that does not report an
        // overlay at all still gets the button: a missing API is not evidence that the band is
        // absent, and the Host answers whether a restart is possible in the first place.
        const overlay = navigator.windowControlsOverlay
        if (overlay !== undefined && overlay.visible === false) return () => {}
        ensureStyle()
          let unmount = mountRestartButton()
          chrome.unmount = () => { unmount(); unmount = () => {} }
          chrome.reposition = () => placeChrome()
          // Placement needs the settings, which are read once in the background: until that answer arrives the
          // button sits where it always did, then moves — or goes away — a moment later.
          chromeStateRequest = request(`${PREFIX}/state`)
          chromeStateRequest
            .then((state) => {
              chromeSettings = state.settings ?? {}
              if (chromeSettings.button === 'settings') chrome.unmount()
              else placeChrome()
            })
            .catch(() => {})
          return () => {
            unmount()
          if (styleElement && styleElement.isConnected) styleElement.remove()
          styleElement = null
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
