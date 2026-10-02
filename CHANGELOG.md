# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-10-02

### Fixed

- **The window came back seconds after the app did, which is what made a restart look like a window toggle.**
  On the machine this was reported from, the log reads `appUp=2348ms` and `windowVisibleMs=6060`: the app was
  serving for nearly four seconds before its window existed, and during that gap it already owned its tray
  icon — so from the outside it looked exactly like "it hid in the tray instead of restarting".
  The window is no longer checked once and raised once: the check starts as soon as the app answers, and while
  a window is missing the shell is nudged again (each nudge is a second launch, which the shell answers by
  showing and focusing its own window), stopping the moment it appears. At most **two** nudges, the last
  attempt only looks, and every attempt is logged — `window check 1/3 visible=false`, and so on.

[0.6.1]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.6.1

## [0.6.0] - 2026-10-02

Everything this plugin was asked for, in one version: the restart lives in Settings, the window is what
proves it worked, and **the application** — not a page, not a window — is what gets closed.

### Fixed

- **The Settings section could never appear.** `client.js` was a module-loader factory that took no
  `require`, so `require('react')` threw, React stayed undefined, and the guard meant to keep a missing
  React from breaking the caption button swallowed the registration with it. The factory now receives the
  loader's `require`, and a test asserts the section really is registered (`settings.section`, id
  `dsh-restart`, order 64) — the assertion 0.5.0 shipped without.
- **Our own scripts ran as the application.** The helper and the guardian were started with
  `process.execPath` — the app's own executable, because the host is Electron running as Node — so a
  process list showed "DeepSeek Harness" while a restart was in flight, and "did the app really close?"
  honestly answered no. They now run under the Node the install ships (`scriptRuntime()`, falling back to
  the old behaviour), so the only processes carrying the application's name are application instances.
- **The window check was four seconds late.** A fresh shell can take seconds to show its window; the check
  — and the raise that makes the shell show and focus it — now happens 1.5 s after the app answers, and the
  moment the window was first seen is recorded as `windowVisibleMs`, so "how long did this restart really
  take" has an answer in the log instead of being an impression.

### What this version does, in one place

- Closes the **whole generation** — shell, host, renderers, helper processes — and proves it:
  `quit.leftovers`, with the strays identified by **creation time**, never by pid.
- Comes back by itself even if the helper dies (the guardian), and proves the window is there:
  `window: visible | raised | hidden` plus `windowVisibleMs`.
- Never shows the crash dialog (the shell is closed before the host exits), never leaves the app closed,
  never leaves a stray process behind.
- A **Settings** section: quit mode (**graceful by default**: the host exits cleanly first, then the shell,
  then the whole generation gets ten seconds to leave on its own, recording `escalated: true` when it has
  to force), **three button positions** (right / left / Settings only) with a pixel offset, the window
  check, the settle time, and **Restart now**.
- Fast where it is ours to be fast: a click starts the app in about **0.15 s**; the app's own boot is the
  floor, and the log says which of the two you are waiting for.
- Rapid clicks are answered with a countdown (`settling`) instead of killing an app that is still starting.

[0.6.0]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.6.0

## [0.5.0] - 2026-10-02

The restart is a feature in Settings now, with options you can change — and it closes the application the
way you asked for, not the way that happened to be fastest.

### Added

- **A Restart section in Settings** (`settings.section`, id `dsh-restart`), built the way
  `dsh-voice-live` builds its own: every option below, plus a **Restart now** button. Each change is sent
  on its own and answered with the complete settings the Host will actually run with. React is loaded
  **optionally** — if the page cannot offer it the section is simply not registered and the caption button
  behaves as before, because a Settings page must never be able to break the restart itself.
- **Settings storage**: `$DSH_HOME/dsh-plugin-restart/settings.json` behind `GET`/`POST
  /dsh-restart/settings`. Every value is validated in one place (`lib/settings.mjs`); an unrecognised one
  falls back to what was already there, so a typo cannot wedge a restart.
- **Two ways to quit, chosen in Settings**:
  - **graceful** (default): the host exits cleanly first, then the shell is closed, then the whole previous
    generation gets **ten seconds** to leave on its own. Only what refuses is closed, and the summary says
    `escalated: true` when that happens.
  - **force**: the whole process tree is closed at once.
  Both report what they actually did: `last-run.json` gained
  `quit: { mode, waitedMs, killed, escalated, leftovers }`.
- **Three button positions** — right of the caption buttons, left of them, or **Settings only** — plus a
  pixel **offset** that works on either side. The left side reuses the same `right` value the stylesheet
  already had, so no stylesheet had to learn about it.
- `docs/dsh-restart-api-request.md`: what DSH would have to expose for a truly graceful quit, with file
  and line references, so this mode can one day be the shell's own quit instead of an orderly teardown.

### Changed

- `DSH_RESTART_RAISE` is now the fallback for the `window` setting (auto / always / report), and
  `DSH_RESTART_SETTLE_MS` for `settleMs`; the quit mode, the window check and the settle time all arrive
  from the Host as flags.
- The window check, the strays test (creation time, never pid) and the guardian are behaviourally unchanged:
  they are what 0.4.1 and 0.4.2 fixed, and their tests still run.

### Known limits

This shell exposes no quit or restart command to plugins: its own graceful path is the tray menu's
"Restart App and Host" (`lib/main.js`: `restartAppHostMenu`, `quitWithoutConfirmation()` to
`app.quit()`), and `background-close-confirmed` means the opposite of a quit — it is what lets a window
close become a silent "hide in the tray". So `graceful` here is the most orderly path a plugin can drive,
not the shell's own `app.quit()`; and a hard-killed app can leave a Windows ghost tray icon until the
pointer passes over it. Both are stated in the README rather than hidden.

[0.5.0]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.5.0

## [0.4.2] - 2026-10-02

### Fixed

**A restart could end with the app hidden in the tray.** The helper called a restart successful once the
app's host answered on its web port — and that is not the same thing as a window on screen. When the desktop
shell's own boot fails it hides the window in the tray and writes a `-web-boot` crash report, so the user
sees exactly "it closed and never came back" while `last-run.json` says `ok=true`. The report that led
here:

```
source: web-boot   phase: startup   shell pid: 41700
Error: Error invoking remote method 'dsh-desktop:boot': Error: Desktop Host is unavailable
```

### Changed

- **The window is now checked, not assumed.** Once the app is up, the helper asks whether the shell it
  started owns a visible window, and only then decides. A missing window is raised (the shell answers a
  second launch by showing and focusing its own window), and the result is reported:
  `last-run.json` gained `window: visible | raised | hidden`, and `relaunch.log` records both checks.
  The good case costs one process query; the bad case costs one app start and gets the window back.
- `DSH_RESTART_RAISE` now defaults to `auto` (raise only when the window is missing). `1` raises
  unconditionally, `0` skips the check and the raise entirely and just reports.

[0.4.2]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.4.2

## [0.4.1] - 2026-10-02

### Fixed

**0.4.0 could close the window it had just opened.** The restart helper clears whatever is left of the
previous generation before the app is left to boot, and 0.4.0 moved that check to *after* the launch while
still matching by **pid**. Those pids are recycled the moment the old generation dies — and the first
process to receive one of them is the app being started. So the helper found the new app's own pid in a
snapshot taken before the launch, waited its five seconds, and killed it, about six seconds in, after the
app had already begun serving. On the machine where this was caught, the log says it exactly:

```
launch attempt 1: pid=2936
stray app process: closing pid 2936     <- the app this helper had just started
```

Strays are now identified by **creation time** (`appProcessesBefore`): only a process that existed before
the helper started can be a leftover, because anything the restart launches is newer. Creation time cannot
be recycled, and a process whose creation time cannot be read is left alone rather than guessed at. The
guardian uses the same test, so it can no longer close a slow-starting app either.

The test harness now asserts both halves: the straggler *is* closed, and the app the helper launched is
*not*. It also tests the mechanism directly, because pid reuse cannot be provoked on demand.

[0.4.1]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.4.1

## [0.4.0] - 2026-10-02

The only part of a restart a user waits for is the part that starts the app, and now nothing else is in
front of it.

### Changed

- **The window raise is off by default.** It costs a whole Electron start and it lands while the app's own
  UI is still loading — the worst possible moment to spend CPU on a nudge, and a freshly started app shows
  its own window anyway. `DSH_RESTART_RAISE=1` turns it back on for a machine where the restored window
  really does come up behind something else; both behaviours are tested.
- **The previous generation is cleared *after* the launch instead of before it.** The enumeration was
  already overlapped with the shell's death, but it still had to be awaited before the app could start.
  Now it is read while the app boots — and reading it late is safe by construction: it was taken before the
  launch, so anything from it that is still alive cannot be the app being started.

### Notes

Measured from a reporter's own `relaunch.log`, five restarts in a row: shell gone at 109–120 ms (100 ms of
which is the deliberate pause that lets the button show "restarting"), app launched at 250–341 ms — of
which ~250 ms was the enumeration 0.3.x did first — and the app serving on its port at 2.49–2.57 s. The
window and UI follow that. **A restart cannot be faster than the app's own boot**: start the app by hand
and time it to see that floor.

[0.4.0]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.4.0

## [0.3.1] - 2026-10-02

### Fixed

- The settle window was measured *after* the window raise, so the lock was held for the raise delay plus
  the settle — about eleven seconds past the app answering — while the button said "the app is still
  starting" about an app that had been up for seconds. It is now measured **from the moment the app
  answers**, with the raise inside it: six seconds, after which a click restarts as it always did.

### Changed

- The single raise happens four seconds after the app answers (was five), inside that window.

[0.3.1]: https://github.com/IHS470/dsh-plugin-restart/releases/tag/v0.3.1

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
