# Feature request: let a plugin ask the desktop shell to quit or restart

Written while building dsh-plugin-restart 0.5.0. Everything below was read out of the installed shell
(`resources/app.asar` → `lib/main.js`, `lib/preload-app.cjs`; Electron 44, `@deepseek-ai/dsh-desktop`
0.2.0-rc.2), so the line numbers are from that build.

## What a plugin cannot do today

A restart plugin needs the application to **quit and come back**. It can end the shell's process itself —
that is what dsh-plugin-restart does — but it cannot ask the shell to quit *the way the application quits*:
its own teardown, its own logging, and a tray icon that disappears because Electron removed it rather than
because the process was killed.

The two things that look like they should work, and do not:

1. **Closing the window.** `lib/main.js` turns a window close into "hide in the tray", and
   `background-close-confirmed` (`lib/main.js:11953`, written by the dialog at `10924-10936`) is the flag
   that makes that hiding **silent**. Its presence means "the user already agreed to hide on close" — the
   opposite of a quit request.
2. **The IPC surface.** Every channel the main process answers in this build:

   ```
   DESKTOP_IPC.boot, bootFailed, browserAcquire, browserRelease, deviceInfo, directoryPick,
   localeBootstrap, onboardingApiKey, shortcutsCloseWindow, shortcutsEdit, shortcutsGet,
   shortcutsRecording, updatesOpen, updatesStatus, windowsMenu,
   MANDATORY_IPC.action, status, PLATFORM_IPC.bounds, close, open,
   UPDATE_DIALOG_IPC.respond, status,
   WELCOME_IPC.analytics, analyticsEnabled, cancel, copyLink, saveApiKey, skip, start, takeNotice
   ```

   No `quit`, `exit` or `restart` among them. `dshDesktop` (preload) exposes only `browser`, `deviceInfo`,
   `shortcuts`, `updates` and `closeWindow` — the last being the shortcut recorder's own window.

Meanwhile the shell already owns exactly the action that is missing. `lib/main.js`:

- `10918-10924`: `quitWithoutConfirmation()` — "Quit without the task confirmation; the caller has already
  decided the application must stop" — sets `skipQuitConfirmation` and calls `app.quit()`.
- `10945-10947`: the comment naming its callers: "crash recovery exit and restart, and the development
  restart command".
- `11918`, `11946`: the menu/tray entry `quitApplication` → `app.quit()`.
- The locale strings already ship a restart item: `restartAppHostMenu: "Restart App and Host"` and
  `restartApplication: "Restart"`.

The capability exists; only the door is missing.

## Proposed change (three small edits)

1. **A channel name**, beside the others in `DESKTOP_IPC`:

   ```js
   restart: "dsh-desktop:restart",
   ```

2. **A handler**, next to the existing ones, using the same-origin assertion the file already has
   (`assertDesktopSender(event, ["app"])`):

   ```js
   ipcMain.handle(DESKTOP_IPC.restart, async (event) => {
     assertDesktopSender(event, ["app"])
     const window = getWindow()
     if (window === undefined || window.isDestroyed()) return { ok: false, reason: "no-window" }
     app.relaunch()
     quitWithoutConfirmation()
     return { ok: true }
   })
   ```

   `quitWithoutConfirmation()` deliberately skips the "running tasks will be interrupted" dialog: a caller
   that has already shown its own confirmation — a plugin's own settings page, say — should not have to ask
   twice.

3. **Expose it** in `lib/preload-app.cjs`, in the same `exposeInMainWorld("dshDesktop", …)` object that
   already carries `updates` and `shortcuts`:

   ```js
   restart: () => electron.ipcRenderer.invoke(DESKTOP_IPC.restart),
   ```

## What a plugin would do with it

dsh-plugin-restart would call `window.dshDesktop.restart()` for its "graceful" mode instead of driving the
teardown itself, and keep its own path only as the fallback for older shells — the same capability probing it
already does for everything else. The user-visible difference is between "the plugin killed the app and
started it again" and **"the app quit and came back"**, which is what people mean by a restart.

## What it costs

Nothing at runtime: no new startup work, one more IPC handler, and the code path it calls
(`quitWithoutConfirmation` + `app.relaunch`) already runs from the tray menu. The origin check is the one
already used for `directoryPick`, so a page outside the Desktop document cannot reach it.

---

## Addendum: a separate, very small request — a Restart item in the tray menu

Independent of the plugin API above, this one is the shell's own UI.

**Today** the tray context menu has exactly two items, defined in `DesktopTray.relabel()` (`lib/main.js:10853-10867`):
Open Application, a separator, and Quit Application — no restart.

**The shell already contains the action**, but only behind the development flag: the application-menu item at
`lib/main.js:11899-11913` is `...development ? [{ reload }, { restartAppHostMenu: app.relaunch() +
quitWithoutConfirmation() }] : []`, so a production build does not show it anywhere.

**A plugin cannot add it**: the tray lives in the shell's main process (`new Tray`, `setContextMenu`); the host is
plain Node without Electron APIs, and the renderer only gets the fixed `dshDesktop` surface (`browser`,
`deviceInfo`, `shortcuts`, `updates`, `closeWindow`) — no Tray, no menus.

**Suggested change** (three places, all in `lib/main.js`):

1. Add to the tray template (before the separator at `10860`):

```js
  { label: messages.restartApplication, click: () => { this.options.restart(); } },
```

2. Pass it to `new DesktopTray({ ... })` (`11939-11948`):

```js
  restart: () => { if (quitting) return; app.relaunch(); quitWithoutConfirmation(); },
```

3. Copy: `restartApplication` already exists in the locale tables; `restartAppHostMenu` ("Restart App and Host")
   is also available if the label should be more explicit.

Besides the convenience, this is the path to a **genuinely clean quit**: it goes through `app.quit()` rather than
a killed process, so Electron removes the tray icon itself — the answer to the recurring "why is the tray icon
still there after a restart".
