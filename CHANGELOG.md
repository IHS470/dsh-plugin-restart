# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-02

The restart stops spending the user's time on its own bookkeeping, the window is no longer raised into
the middle of the app's boot, and two restarts in quick succession can no longer start two of them.

### Fixed

- **0.2.0 put a process enumeration on the critical path.** Closing the shell cost about 0.3 s and the
  `tasklist` scan that followed cost about 0.25 s more, both before the app was allowed to start. The
  scan now *overlaps* the shell's death — started before the shell is closed, read afterwards — so the
  app starts in about the time the shell takes to go.
- **The guardian could release a lock whose restart was still running.** It cleared the lock whenever it
  had to act, which would let the next click start a second helper; two helpers each closing a shell and
  starting an app is a good way to end up with a stuck machine. It now leaves a live restart's lock
  alone and clears only an abandoned one.
- **A restart a couple of seconds after the previous one killed an app mid-boot**, which is the other way
  a restart looks stuck. The lock is now held until the app has kept answering for six seconds, and a
  click during that window is answered `settling` with the time left to wait — the button counts down
  instead of appearing to do nothing.

### Changed

- The shell is closed with `process.kill` instead of starting `taskkill.exe` (worth about 0.1 s on its
  own), and the lock carries its own `settleUntil`: a lock that outlives its restart stops counting then,
  rather than after the three-minute bound.
- The window is raised **once, about five seconds after the app answers** instead of three, so the raise
  lands on a window that exists rather than competing with the app's own boot for CPU.
- `GET /dsh-restart/state` reports `stage`, and `POST /dsh-restart/restart` can answer
  `{ok:false, code:'settling', retryInMs}`.
- `DSH_RESTART_SETTLE_MS` overrides the six-second settle.

### Notes

Click-to-launch measures about **0.3 s** here (0.1.1: 0.32 s; 0.2.0: ~0.65 s, with the scan in series) —
and the app's own boot is untouched: it answers on its web port about 2.5 s after the launch and shows
its window some time after that. That floor belongs to the app, not to this plugin, and the marks in
`relaunch.log` say which of the two you are waiting for.

[0.3.0]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.3.0

## [0.2.0] - 2026-10-02

The restart can no longer end with the app closed, and it no longer fights the app it replaces.

A restart is performed by a helper process that closes the desktop shell and starts the app again. Two
things could still go wrong, and both of them end the same way for the user — an app that does not come
back:

- If the helper died in between (killed, a suspended machine, a security tool, every launch attempt
  losing the single-instance race), nothing was left to start the app.
- A killed Electron shell can leave children behind for a moment. They hold the profile open, and an
  app that starts into a held profile is the classic way to end up with a running process and no
  window.

### Added

- **A guardian**: the host starts `lib/guardian.mjs` *before* the helper, and it outlives both. If the
  app has not answered on its web port within 25 s of a restart starting, the guardian releases the
  dead helper's lock and starts the app itself, up to three times. It is deliberately blunt — no state
  of its own, any failure ends in a log line — because it is the code that runs when everything else
  has already gone wrong. `DSH_RESTART_GUARDIAN_GRACE_MS` overrides the grace.
- **The previous generation is cleared before the next one starts**: every process running the app's
  image is accounted for after the shell dies, and whatever survives the wait is closed by pid. The
  summary reports how many (`straysClosed`).
- `guardian.log` beside the other diagnostics, and `last-run.json` gained `straysClosed` and `pokes`.

### Changed

- **The window is raised once, not three times.** Each raise is a whole Electron start competing with
  the app that is still booting, which is a lot of work for a nudge. A raise that lingers after handing
  over to the running instance is now closed again instead of being left as a second instance.
- The old host is confirmed gone *after* the launch rather than waited on before it — it leaves on its
  own within about a tenth of a second, and that wait used to sit on the user's clock.
- `DSH_RESTART_POKE_MS` is now the delay before that single raise (default 3000 ms) rather than a list
  of gaps.

[0.2.0]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.2.0

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
