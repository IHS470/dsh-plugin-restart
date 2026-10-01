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
whole job is done with `cmd` / `taskkill` / `start`, and there is no equivalent there. Closing a
shell it cannot bring back would be worse than offering no button.

## How it works

The desktop shell runs the dsh host as a **plain Node child** (`dsh-desktop-host`), so
`require('electron')` inside a plugin has no `app` to relaunch with; and the shell holds a
**single-instance lock**, so starting the app while it lives would only focus the old window. A
restart is therefore four things, each one forced by observed behaviour:

1. **Close the shell first, and only then let the host exit.** The shell reports *any* host exit as a
   crash — a clean `process.exit(0)` included — and puts 「应用无法启动或已意外停止」 with the host's
   stderr tail on screen, writing a crash report per restart. Close the shell first and it never gets
   to see anything. The host cooperates: it no longer exits on a timer, it **polls the shell's pid**
   and exits once it is gone (with a four-second bound, so a helper that never arrived still ends at
   the shell's own recovery dialog).
2. **Close by pid, never with `/T`.** The helper is a grandchild of the shell
   (`shell → host → helper`), so a tree kill would take the helper down before it relaunched
   anything. If the shell has not gone in 1.5 s the helper closes it once more, and confirms
   `alive=false` instead of assuming.
3. **Start the app through `start`**, the way Explorer does, so the new instance owns a normal,
   visible window and sits outside the old process tree.
4. **Strip `ELECTRON_RUN_AS_NODE` before launching.** That variable is how the shell runs the host as
   Node, so the helper inherits it; passed on to the app, Electron starts as a script-less Node
   process: no window, instant exit — exactly "the app closed and never came back".

The page also never ends with `window.close()`: the desktop shell turns a window close into **hide
the app in the tray and keep running**, and the single-instance lock belongs to the process rather
than the window, so closing it releases nothing. The window stays up saying "restarting" and goes
away with the old process.

The helper logs every step to `$DSH_HOME/dsh-plugin-restart/relaunch.log`; attach it to a bug report.

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
| Host half | `test/host.test.mjs` | Capability probing (`available === false` under a plain Node host, with the reason), `POST /restart` answering `unavailable` instead of pretending, four refusal paths of the trust fence plus same-origin, the host guard rejecting and allowing, unknown paths and `GET /restart` as 404 |
| Browser half | `test/client.test.mjs` | Loads `client.js` against stubbed DOM/fetch: the button mounts into the window chrome, `--dsh-restart-right` comes from the caption-overlay rectangle (stub: 1280 wide → 142px), the height follows `--dsh-windows-titlebar-height`, one click only arms a visible popover, cancel asks the host for nothing, confirming POSTs exactly once and says "restarting", the window is **never** closed, the notice outlives the popover's 8-second auto-close, nothing mounts when the overlay reports no band, and disposal removes the chrome |
| Relaunch helper | `test/relaunch.test.mjs` | Runs the real `lib/relaunch.mjs` against stand-ins: disposable processes for the shell and the host, a `.cmd` for the app (appending a line per launch and reporting `%ELECTRON_RUN_AS_NODE%`), a 401 stub port for the web port. Three scenarios (host exits by itself / host overstays / no web address) assert the shell is closed and confirmed gone, the host is left alone when it leaves and closed when it does not, the app starts **only after both are gone**, `ELECTRON_RUN_AS_NODE` never reaches the app, the app is launched three times (one restart + two raises), and no kill ever uses `/T` |

```sh
npm test
```

## License

MIT © 2026 IHS470 · see [LICENSE](LICENSE)
