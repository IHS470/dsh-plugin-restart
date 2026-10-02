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
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
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
      function place() {
        let right = 138
        if (overlay && typeof overlay.getTitlebarAreaRect === 'function') {
          const rect = overlay.getTitlebarAreaRect()
          if (rect && rect.width > 0) right = Math.max(0, Math.round(window.innerWidth - rect.right))
        }
        const root = document.documentElement.style
        root.setProperty('--dsh-restart-right', `${right + 4}px`)
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
          const state = await request(`${PREFIX}/state`)
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

    /** Nothing is injected: the button is chrome, not a slot entry. */
    const inject = []

    function apply(ctx) {
      ctx.effect(() => {
        // Overlay windows only. A window whose overlay reports itself invisible has no caption
        // band to sit in (full screen), so nothing is mounted. A window that does not report an
        // overlay at all still gets the button: a missing API is not evidence that the band is
        // absent, and the Host answers whether a restart is possible in the first place.
        const overlay = navigator.windowControlsOverlay
        if (overlay !== undefined && overlay.visible === false) return () => {}
        ensureStyle()
        const unmount = mountRestartButton()
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
