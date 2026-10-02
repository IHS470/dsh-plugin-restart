# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-02

A pass over the restart itself: faster where the plugin was the bottleneck, and harder to get wrong
where the environment is.

### Changed

- **The app is started as soon as the shell is gone.** The old flow waited for the old host to exit
  (up to 5 s) and then slept 400 ms for the single-instance lock before launching — two serial waits
  on the user's clock that bought nothing. The launch now happens immediately after the shell is
  confirmed gone, and the old host is confirmed gone afterwards, in parallel with the app's own
  boot. Measured from helper start to app launch: **≈0.4 s in the test harness, against ≈0.85 s
  measured the same way from 0.1.0's log of a real restart.**
- The app is launched **directly** rather than through `cmd /c start`, so the helper owns its pid and
  can tell a real launch from one that lost the single-instance race — and the app's own output is
  captured to `app.log`.
- Helper arguments are **named** (`--host= --web= --lock=`), with the older positional form still
  accepted, because the helper is read from disk at spawn time while the host was loaded at boot:
  the first restart after an update really does run an older host against a newer helper.

### Added

- **A launch that does not take is retried**: an instance that loses the single-instance race exits
  within a moment, and that exit is now detected (with its exit code) and retried up to three times.
- **Nothing is closed that cannot be replaced**: a missing executable, or an app path that is not an
  executable image, ends the restart before the shell is touched — and the capability reports
  `app-unusable` rather than offering a button that would strand the user.
- **One restart at a time**: the host holds a lock while a helper is in flight, answers a second
  click with `{ ok: false, code: 'busy' }`, and clears a stale lock instead of wedging the button.
- **The last restart is readable**: `GET /dsh-restart/state` now reports the plugin version, whether
  a restart is running, and the outcome of the last one; the helper writes it to `last-run.json`
  with timings, launch attempts and poke count.
- **The browser tells the truth when nothing happens**: a restart that has not taken effect after
  5 s says so and re-enables the buttons, and a restart that is already in flight says that instead.
- **Enter confirms** the popover (ignored while typing in a prompt), and `DSH_RESTART_POKE_MS`
  overrides the window-raise schedule for a machine that boots unusually slow or fast.

### Fixed

- An optional positional argument could shift: a missing web address made the **lock path parse as
  the URL**, costing a pointless 25-second poll. Arguments are named now, and a URL that is not
  `http(s)` is dropped.
- A `.cmd`-style app path would have closed the shell and then failed to launch anything (`spawn`
  cannot start a script) — refused before anything is closed.

[0.1.1]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.1.1

## [0.1.0] - 2026-10-02

First release, extracted from the restart button that shipped inside `dsh-voice-live` so it can be
installed on its own.

### Added

- A restart button in the window's caption band, left of the native window buttons, positioned from
  the live caption-overlay rectangle; hidden when the overlay reports no band (full screen).
- A visible confirmation popover (restart / cancel), which stays up — past its own auto-close
  timer — while the app is on its way out.
- `GET /dsh-restart/state` (capability, with the reason when unavailable) and
  `POST /dsh-restart/restart`, both behind DSH's same-origin trust fence.
- `lib/relaunch.mjs`: a detached helper that closes the shell by pid, waits for the host to exit,
  starts the app the way Explorer does, and pokes it twice so the window comes to the front.
- Three test harnesses (host half, browser half, relaunch helper) wired into `npm test`, and GitHub
  Actions for tests and for tagged npm releases with provenance.

### Notes

- Windows only: the helper's whole job is `cmd` / `taskkill` / `start`. Elsewhere the capability
  reports `unsupported-platform` and the button says so instead of closing a shell it cannot
  restart.
- The shell is closed **before** the host exits, because the shell reports any host exit as a crash
  and puts a dialog on screen over a host that is already gone.
- `ELECTRON_RUN_AS_NODE` is stripped from the launch environment: passing the shell's own
  "run this as Node" flag to the app starts it without a window.

[0.1.0]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.1.0
