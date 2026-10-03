# Changelog

## [2.0.2] - 2026-10-03

### Fixed

- **The release tool derived a release title from a markdown heading**, which produced names like
  `[2.0.1] - 2026-10-03`. The title is now the tag itself and the changelog section is the body — and because the
  release workflow does not read the changelog, the tool publishes the release itself instead of leaving the notes to
  a placeholder (the tool used to claim the workflow would do it, which was simply wrong).
- **One assertion in the relaunch harness was stronger than the runtime it tests.** It required the helper's log to
  contain `host exited after …` or `host: closing pid`, but v0.1.0's helper only writes that line when it catches the
  host leaving in the act — a race that failed on one platform out of six while the behaviour was correct (the host
  being gone is asserted separately, as is an overstaying host being closed). The assertion is gone; the runtime is
  untouched, still byte for byte the v0.1.0 code.

## [2.0.1] - 2026-10-03

### Fixed

- **The release pipeline lived outside the repository and only ever added files.** It built each commit on top of the
  branch's existing tree (`base_tree`), so a file deleted locally stayed in the repository: the first `v2.0.0` tag
  carried four files from the 1.0.x line (`lib/guardian.mjs`, `lib/proc.mjs`, `lib/settings.mjs`,
  `test/guardian.test.mjs`) that this line does not contain, while claiming to be the v0.1.0 runtime byte for byte.
  The pipeline is now `tools/release.mjs`, inside the repository, and it **mirrors the working tree**: a path that is
  gone locally is deleted in the commit, and every file is addressed by its git blob hash so that "changed" means
  changed bytes.
- It refuses to publish when the changelog has no section for the version, when the tag already exists, or when the
  tests are red, and it can be asked what it would do first: `node tools/release.mjs --dry-run`, plus
  `node tools/release.mjs --selftest`, which tests the deletion case that went wrong.
- No runtime change: the plugin is still the v0.1.0 code, byte for byte.

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
