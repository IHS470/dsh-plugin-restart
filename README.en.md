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
restart is therefore six things, each one forced by observed behaviour:

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
3. **Start the app as soon as the shell is gone — do not wait for the old host.** The old host leaves
   on its own about a tenth of a second after the shell dies, while the new app needs several seconds
   before its own host binds the port: waiting here was serial latency on the user's clock. The order
   is now: confirm the shell is gone → start the app → confirm the old host is gone, in parallel with
   the app's own boot. **Measured from helper start to app launch: ~0.37 s, down from ~0.85 s.** The
   app's own boot time is unchanged.
4. **Launch the executable directly, and verify that the launch took.** Owning the pid is what lets
   the helper tell a real start from one that lost the single-instance race and died — those are
   detected (with their exit code) and retried, up to three times.
5. **Strip `ELECTRON_RUN_AS_NODE` before launching.** That variable is how the shell runs the host as
   Node, so the helper inherits it; passed on to the app, Electron starts as a script-less Node
   process: no window, instant exit — exactly "the app closed and never came back".
6. **Poke the app once it answers.** The shell answers a second launch by focusing its own window
   (`second-instance`), which is the only lever a plugin has on window visibility. The default
   schedule pokes 2 s / 6 s / 12 s after the app answers (override with `DSH_RESTART_POKE_MS`) to
   cover the gap before the app has entered its workspace — and a poke that lands after the app died
   simply becomes the app.

The page also never ends with `window.close()`: the desktop shell turns a window close into **hide
the app in the tray and keep running**, and the single-instance lock belongs to the process rather
than the window, so closing it releases nothing. The window stays up saying "restarting" and goes
away with the old process; if it is still there after five seconds it says the restart did not take
effect, instead of spinning forever.

Also in this version: one restart at a time (the host holds a lock, a second click is answered
`busy`, stale locks are cleared), `GET /dsh-restart/state` reporting the plugin version, whether a
restart is running and how the last one ended, and named helper arguments (`--host=` / `--web=` /
`--lock=`) that still accept the previous positional form — the helper is read from disk at spawn
time, so the first restart after an update really does run an older host against a newer helper.

## Diagnostics

Everything lives in `$DSH_HOME/dsh-plugin-restart/`:

| File | What it holds |
|---|---|
| `relaunch.log` | A timestamped step per line; `done ok=… attempts=… pokes=… shellGone=…ms appStarted=…ms total=…ms` is the summary |
| `app.log` | **The app's own** stdout/stderr, rewritten on every restart (one boot per file). Had this existed in 0.1.0, "the app never came back" would have been obvious at a glance |
| `last-run.json` | The machine-readable summary — `ok` / `answered` / `attempts` / `appExit` / `pokes` / `gaps` / `ms` — which is what `/dsh-restart/state` reports as `last` |
| `relaunch.lock` | The in-flight lock; removed when the helper finishes, and treated as stale after three minutes |

Attach `relaunch.log` and `last-run.json` to a bug report.

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

Three harnesses, all driving the real code; `npm test` runs them all (`test/relaunch.test.mjs`
really runs only on Windows and prints SKIP with exit 0 elsewhere):

| Check | Script | Covers |
|---|---|---|
| Host half | `test/host.test.mjs` | Capability probing (`available === false` under a plain Node host, with the reason), `POST /restart` answering `unavailable` with that reason, `/state` reporting the plugin version, `busy`, and `last`, **one restart at a time** (a fresh lock means `busy: true` and `{ok:false, code:'busy'}`; a ten-minute-old lock does not count), four refusal paths of the trust fence plus same-origin, the host guard rejecting and allowing, unknown paths and `GET /restart` as 404 |
| Browser half | `test/client.test.mjs` | Loads `client.js` against stubbed DOM/fetch: the button mounts into the window chrome, `--dsh-restart-right` comes from the caption-overlay rectangle (stub: 1280 wide → 142px), the height follows `--dsh-windows-titlebar-height`, one click only arms a visible popover, cancel asks the host for nothing, confirming POSTs exactly once and says "restarting", the window is **never** closed, a restart that has not taken effect after five seconds says so instead of spinning, the notice outlives the popover's 8-second auto-close, `busy` has its own message, **Enter confirms — but never while typing in a prompt**, nothing mounts when the overlay reports no band, and disposal removes the chrome |
| Relaunch helper | `test/relaunch.test.mjs` | Runs the real `lib/relaunch.mjs` against stand-ins (the Node executable plus a `NODE_OPTIONS`-injected probe for the app, disposable processes for the shell and the host, a 401 stub port for the web port) in **six scenarios**: host exits by itself / host overstays / no web address / executable missing / app path is a script / the first launch loses the single-instance race. They assert the shell is closed and confirmed gone, the app starts **before the old host is confirmed gone** (that is where 0.1.1 saved the time), the host is left alone when it leaves and closed when it does not, `ELECTRON_RUN_AS_NODE` never reaches the app, **nothing is closed when the app cannot be started**, a lost race is retried with its exit code recorded, the app's output lands in `app.log`, `last-run.json` agrees with the log (`ok`/`attempts`/`appExit`/`pokes`/`gaps`/`ms`), the lock is always released, no kill ever uses `/T`, and the previous positional argument form still parses |

```sh
npm test
```

## License

MIT © 2026 IHS470 · see [LICENSE](LICENSE)
