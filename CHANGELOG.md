# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
