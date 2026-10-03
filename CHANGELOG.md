# Changelog

## [2.0.0] - 2026-10-03

2.0.0 is a deliberate **re-base, not an increment**. The runtime is the original **v0.1.0** code — restored because
that is the behaviour its user preferred — and the repository additionally ships the tool that puts a **Restart item
in the desktop shell's tray menu**.

### The runtime is v0.1.0, byte for byte
- One button in the window's caption band. A click kills the shell, launches the application, and pokes the window
  twice. No settings page, no guardian, no stray cleanup, no lock — click as often as you like.
- `client.js`, `lib/index.js`, `lib/relaunch.mjs` and `cordis.patch.yml` are **byte-identical to the `v0.1.0` tag**;
  the SHA256 of each is checked while this release is built.

### Added
- **`tools/patch-shell-tray.mjs`** — adds **"Restart DeepSeek Harness"** to the tray menu of the installed shell by
  patching `lib/main.js` inside `resources/app.asar`. The tray belongs to the shell's main process, so no plugin can
  add an item to it; this is a local, reversible patch instead. It detects the installation, rebuilds the archive from
  a pristine base, verifies the result file by file, swaps it in through a process created with WMI (the application
  kills its descendants otherwise), and restores the original if the patched archive does not start.
  Commands: `status`, `build`, `detach`, `swap`, `revert`.
- `docs/dsh-restart-api-request*.md` — the shell-side change that would make the tray item official, with line numbers.
- The test harnesses are the v0.1.0 ones, **unchanged**; they pass on the machine this was built on. CI runs them on
  six platforms, so it is the place that decides whether they are stable enough.

### Where the 1.0.x line went
`v1.0.0` – `v1.0.4` remain available at their tags. That line added a settings page, a choice between "v0.1.0 classic"
and "latest" restart styles, a guardian process, stray-process cleanup and many correctness fixes. **2.0.0 does not
contain any of that** — by request.
