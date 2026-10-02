# dsh-plugin-restart

English | [中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-plugin-restart)](https://www.npmjs.com/package/dsh-plugin-restart)
[![test](https://github.com/IHS470/dsh-plugin-restart/actions/workflows/ci.yml/badge.svg)](https://github.com/IHS470/dsh-plugin-restart/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-plugin-restart)](LICENSE)

**A restart button in the title bar of the DeepSeek Harness desktop app.** One click, one
confirmation, and the app closes and comes back with its window in front — instead of hiding in the
tray, and without the shell's 「应用无法启动或已意外停止」 crash dialog.

- **One button**, in the caption band just left of the native minimize / maximize / close buttons,
  positioned from the live caption-overlay rectangle so it never overlaps them at any DPI. Full
  screen drops the band, and the button with it.
- **The confirmation is a visible popover**, not "the button turns red, click it again" — it sits
  next to Close, and "nothing happened" is the worst possible feedback there.
- **The restarted app comes to the front**: once the app answers again, the helper pokes it once
  more, and the shell answers a second launch by focusing its own window.
- **No dependencies, no configuration, no on-disk state** (beyond the helper's log), and it does not
  need any host-version-specific settings namespace.

## Install

```sh
dsh plugin --profile desktop add dsh-plugin-restart
```

(`desktop` is the desktop app's profile name; if you launch the host yourself with `dsh web`, use
`--profile web`.)

Then **restart DeepSeek Harness once** (so the bundle joins the composed tree); after a page refresh
the button is in the title bar.

> The caption band holds exactly one spot: another plugin that puts a button there will sit on top of
> this one.

**Requirements**: Windows plus the DeepSeek Harness desktop app (the Electron shell). Other
platforms can install it, but the button will report that restart is unavailable — the helper's
whole job is built on `taskkill` and the Windows single-instance behaviour, and there is no
equivalent there. Closing a shell it cannot bring back would be worse than offering no button — the
same judgement applies when the app itself is gone: a moved, uninstalled, or non-executable app path
reports `app-unusable` rather than closing anything.

## How it works

The desktop shell runs the dsh host as a **plain Node child** (`dsh-desktop-host`), so
`require('electron')` inside a plugin has no `app` to relaunch with; and the shell holds a
**single-instance lock**, so starting the app while it lives would only focus the old window. A
restart is therefore these things, each one forced by observed behaviour:

1. **Close the shell first, and only then let the host exit.** The shell reports *any* host exit as a
   crash — a clean `process.exit(0)` included — and puts 「应用无法启动或已意外停止」 with the host's
   stderr tail on screen, writing a crash report per restart. Close the shell first and it never gets
   to see anything. The host cooperates: it no longer exits on a timer, it **polls the shell's pid**
   and exits once it is gone (with a four-second bound, so a helper that never arrived still ends at
   the shell's own recovery dialog).
2. **Close by pid, never with `/T`.** The helper is a grandchild of the shell
   (`shell → host → helper`), so a tree kill would take the helper down before it relaunched
   anything. If the shell has not gone in 1.2 s the helper closes it once more, and confirms
   `alive=false` instead of assuming.
3. **The previous generation is gone before the next one starts.** A killed Electron shell can leave
   children behind for a moment — renderers, GPU helpers, a host that has not exited yet. They hold the
   profile open, and an app that starts into a held profile is the classic way to end up with a running
   process and no window. So every process running the app's image is accounted for, and whatever
   survives is closed by pid; the summary reports how many (`straysClosed`). **Strays are identified by
   creation time, not by pid — a lesson 0.4.0 paid for: those pids are recycled the moment the old
   generation dies, and the first process to receive one is usually the app just launched, so the helper
   closed its own window six seconds in.** The check runs *after* the launch (a second of CIM is on
   nobody's clock there), and a process whose creation time cannot be read is left alone rather than
   guessed at.
4. **Start the app as soon as the shell is gone — do not wait for the old host.** The old host leaves
   on its own about a tenth of a second after the shell dies, while the new app needs several seconds
   before its own host binds the port: waiting here was serial latency on the user's clock. The shell is
   also closed with `process.kill` instead of starting `taskkill.exe`, another tenth of a second. The
   order is: start the enumeration → close the shell → read the enumeration and clear what is left →
   start the app → confirm the old host is gone, in parallel with the app's own boot. **Measured from a
   click to the app's launch: ~0.3 s** (0.1.1: 0.32 s; 0.2.0: ~0.65 s). The app's own boot is unchanged —
   it answers on its port about 2.5 s after the launch and shows its window after that, and **that floor
   belongs to the app, not to this plugin**.
5. **Launch the executable directly, and verify that the launch took.** Owning the pid is what lets
   the helper tell a real start from one that lost the single-instance race and died — those are
   detected (with their exit code) and retried, up to three times.
6. **Strip `ELECTRON_RUN_AS_NODE` before launching.** That variable is how the shell runs the host as
   Node, so the helper inherits it; passed on to the app, Electron starts as a script-less Node
   process: no window, instant exit — exactly "the app closed and never came back".
7. **The window raise is off by default (`DSH_RESTART_RAISE=1` turns it on).** The shell answers a second launch
   by focusing its own window (`second-instance`), which is the only lever a plugin has on window
   visibility, and each poke is a whole Electron start competing with an app that is still booting. So
   it happens once, **4 s after the app answers**, inside the settle window below (`DSH_RESTART_POKE_MS` overrides that delay) — three
   pokes at 2/6/12 s is what 0.1.x spent that CPU on. A poke that lingers after handing over, while the
   app this helper started is still alive, is closed again rather than left as a second instance.
8. **The lock is held until the app has actually settled.** Six seconds of the app answering
   (`DSH_RESTART_SETTLE_MS` overrides it) before the lock is released, so a click a couple of seconds
   later gets a **clear answer instead of killing an app that is still starting** — which is what two
   restarts close together used to do. The host answers `{ok:false, code:'settling', retryInMs}` and the
   button counts those seconds down. The lock carries its own `settleUntil`, so a lock whose helper never
   got to release it stops counting by itself.
9. **There is an independent witness.** Before starting the helper, the host starts
   `lib/guardian.mjs`, which outlives both. If the app has not answered on its web port within 25 s of
   the restart starting — the helper died, the machine suspended, every launch lost the race — the
   guardian **starts the app itself**, up to three times. It only clears a lock whose owner is *gone*:
   releasing a live restart's lock would let the next click start a second helper, and two helpers each
   closing a shell and starting an app is a good way to end up with a stuck machine. It is deliberately
   blunt, because it is the code that runs when everything else has already gone wrong.
   `DSH_RESTART_GUARDIAN_GRACE_MS` overrides the grace.

The page also never ends with `window.close()`: the desktop shell turns a window close into **hide
the app in the tray and keep running**, and the single-instance lock belongs to the process rather
than the window, so closing it releases nothing. The window stays up saying "restarting" and goes
away with the old process; if it is still there after five seconds it says the restart did not take
effect, instead of spinning forever.

Also in this version: one restart at a time (the host holds a lock, a second click is answered `busy`; a
lock that is only waiting out the app's boot answers **`settling` with the milliseconds left**; stale
locks and locks past their `settleUntil` are cleared), `GET /dsh-restart/state` reporting the plugin
version, whether a restart is running, **which stage it is in** and how the last one ended, and named
helper arguments (`--host=` / `--web=` / `--lock=`) that still accept the previous positional form — the
helper is read from disk at spawn time, so the first restart after an update really does run an older host
against a newer helper.

## Diagnostics

Everything lives in `$DSH_HOME/dsh-plugin-restart/`:

| File | What it holds |
|---|---|
| `relaunch.log` | A timestamped step per line; `done ok=… attempts=… pokes=… straysClosed=… shellGone=…ms clean=…ms appStarted=…ms total=…ms` is the summary |
| `guardian.log` | The witness's reasoning: when the shell disappeared, when it decided the app was not coming back, how often it started the app itself, whether it released an abandoned lock — and whether it left a live restart's lock alone |
| `app.log` | **The app's own** stdout/stderr, rewritten on every launch (one boot per file). Had this existed in 0.1.0, "the app never came back" would have been obvious at a glance |
| `last-run.json` | The machine-readable summary — `ok` / `answered` / `attempts` / `pokes` / `straysClosed` / `appExit` / `ms` — which is what `/dsh-restart/state` reports as `last` |
| `relaunch.lock` | The in-flight lock, carrying its `stage` and `settleUntil`; removed when the helper finishes, treated as stale past `settleUntil` or after three minutes, and released by the guardian only when its owner is gone |

Attach `relaunch.log`, `guardian.log` and `last-run.json` to a bug report.

## Security

- Every route goes through DSH's same-origin trust fence: cross-site markers, a foreign `Origin` and
  a non-loopback `Host` are all 403, and the host's own `connection` guard takes precedence when it
  exists. Restarting is `POST` only.
- The web address handed to the helper comes from the `Host` header of the request the browser just
  made, and is accepted only when it is loopback — a spoofed header cannot point the helper at
  another machine.
- Apart from `relaunch.log` the plugin **writes nothing and reports nothing**; it makes no network
  requests.
- It does exactly one thing: restart this application, on this machine.

## Tests

**Four harnesses**, all driving the real code; `npm test` runs them all (`test/relaunch.test.mjs` and
`test/guardian.test.mjs` really run only on Windows and print SKIP with exit 0 elsewhere):

| Check | Script | Covers |
|---|---|---|
| Host half | `test/host.test.mjs` | Capability probing (`available === false` under a plain Node host, with the reason), `POST /restart` answering `unavailable` with that reason, `/state` reporting the plugin version, `busy`, and `last`, **one restart at a time** (a fresh lock means `busy: true` and `{ok:false, code:'busy'}`; a ten-minute-old lock does not count), four refusal paths of the trust fence plus same-origin, the host guard rejecting and allowing, unknown paths and `GET /restart` as 404 |
| Browser half | `test/client.test.mjs` | Loads `client.js` against stubbed DOM/fetch: the button mounts into the window chrome, `--dsh-restart-right` comes from the caption-overlay rectangle (stub: 1280 wide → 142px), the height follows `--dsh-windows-titlebar-height`, one click only arms a visible popover, cancel asks the host for nothing, confirming POSTs exactly once and says "restarting", the window is **never** closed, a restart that has not taken effect after five seconds says so instead of spinning, the notice outlives the popover's 8-second auto-close, `busy` has its own message, **Enter confirms — but never while typing in a prompt**, nothing mounts when the overlay reports no band, and disposal removes the chrome |
| Guardian | `test/guardian.test.mjs` | Runs the real `lib/guardian.mjs`: with **nothing serving** it starts the app itself and releases a dead helper's lock (asserting the environment it hands over has no `ELECTRON_RUN_AS_NODE`); with **an app already serving** it does nothing at all and exits 0; with the **lock owned by a live process** it still starts the app but **never touches that lock**, because releasing it would let the next click start a second restart |
| Relaunch helper | `test/relaunch.test.mjs` | Runs the real `lib/relaunch.mjs` against stand-ins — a **copy** of the Node executable with its own image name (the helper counts processes by image, so the stand-in has to be distinguishable from the harness and the helper, exactly like the real app) running a `NODE_OPTIONS`-injected probe, disposable processes for the shell and the host, a 401 stub port for the web port — in **seven scenarios**: host exits by itself / host overstays / no web address / the older positional argument form / executable missing / app path is a script / the first launch loses the single-instance race / a straggler of the previous generation outliving the shell. They assert the shell is closed and confirmed gone, a straggler is **closed by pid before the app starts** (`straysClosed`), the app starts **before the old host is confirmed gone** (where the time was saved), `ELECTRON_RUN_AS_NODE` never reaches the app, **nothing is closed when the app cannot be started**, a lost race is retried with its exit code recorded, the window is raised exactly once, the app's output lands in `app.log`, `last-run.json` agrees with the log, the lock is always released, and no kill ever uses `/T` |

```sh
npm test
```

## License

MIT © 2026 IHS470 · see [LICENSE](LICENSE)
