# dsh-plugin-restart 2.0.0

A restart button for the DeepSeek Harness desktop app: **one button in the window's caption band** that closes the
whole application and brings it back. The 2.0.0 runtime **is the original v0.1.0**, byte for byte; the repository also
ships the tool that puts **"Restart DeepSeek Harness" into the shell's tray menu**.

| | What it is | How to use |
|---|---|---|
| **Plugin (runtime)** | Caption-band button: kills the shell, launches the app, pokes the window twice. No settings page, no lock — click as often as you like | Install it as a DSH plugin |
| **`tools/patch-shell-tray.mjs`** | Adds a Restart item to the shell's tray menu, calling the shell's own `app.relaunch()` + `quitWithoutConfirmation()` — so **Electron removes the tray icon itself** | See below |

**Why a plugin cannot provide the tray item**: the tray lives in the shell's main process (`new Tray`,
`setContextMenu`). The host is plain Node without Electron APIs, and the page only gets the fixed `dshDesktop` preload
surface, so neither can add an entry. It is therefore a local, reversible shell patch; the long-term fix is in
`docs/dsh-restart-api-request.md`, with line numbers.

```bash
node tools/patch-shell-tray.mjs status | build | detach | swap | revert
```

The tool detects the installation, backs the original up as `app.asar.orig`, verifies the rebuilt archive file by file,
and restores the original within 40 seconds if the patched archive does not start. It patches the **vendor's packaged
application**: an update or reinstall overwrites `app.asar` and `build` + `detach` have to be run again.

Being honest: 2.0.0 does **not** contain what the 1.0.x line added (settings page, restart-style switch, guardian,
stray cleanup, settle lock) — those remain at their tags `v1.0.0`–`v1.0.4`. The caption-band button restarts by killing
the process, which can leave a ghost tray icon on Windows; the tray item does not. Windows only.
