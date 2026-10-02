/**
 * Guardian harness for dsh-plugin-restart.
 *
 * The guardian is the answer to the one outcome this plugin must not have: a restart that closes the
 * app and never brings it back, because the helper died before it could start it. This runs the real
 * `lib/guardian.mjs` against the same stand-in the relaunch harness uses — a copy of the Node
 * executable that records every launch — and checks both halves of its judgement:
 *
 *   1. when nothing is serving, it starts the app itself, and releases the lock a dead helper left
 *   2. when an app is already serving, it does nothing at all and exits
 *
 * Windows only, like the rest of the restart path.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log(`SKIP: the guardian is Windows-only (platform: ${process.platform})`)
  process.exit(0)
}

const GUARDIAN = fileURLToPath(new URL('../lib/guardian.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'dsh-restart-guardian-'))
// Its own image name, not shared with the relaunch harness: see the note there.
const appExe = join(root, 'dsh-guardian-standin.exe')
const probe = join(root, 'probe.mjs')
copyFileSync(process.execPath, appExe)

/** Records one line per launch, with the environment it was handed. */
writeFileSync(probe, [
  "import fs from 'node:fs'",
  'if (process.argv[1] === undefined) {',
  `  fs.appendFileSync(process.env.PROBE_MARKER, \`launch node=\${process.env.ELECTRON_RUN_AS_NODE ?? ''}\\n\`)`,
  '  setTimeout(() => process.exit(0), Number(process.env.PROBE_LIFE_MS) || 1500)',
  '}',
  '',
].join('\n'))

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')

/** A pid that is certainly gone: this process's own parent is not guaranteed, so make one up. */
const DEAD_PID = 999999

/**
 * Run the guardian with the shortened grace the harness needs, and stop it once `until` is true.
 *
 * `hostPid` is what the guardian takes for the host it is watching: a dead pid (the usual case — the
 * host it was started for is gone) or a live one, which is how the harness asks whether the guardian
 * respects a restart that is still somebody else's business.
 */
async function runGuardian(name, { web, lockPath, logPath, marker, until, timeoutMs = 20000, hostPid = DEAD_PID }) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PROBE_MARKER: marker,
    DSH_RESTART_GUARDIAN_GRACE_MS: '1200',
    NODE_OPTIONS: `--import ${new URL(`file:///${probe.replace(/\\/g, '/')}`).href}`,
  }
  const child = spawn(process.execPath, [
    GUARDIAN,
    appExe,
    `--web=${web}`,
    `--lock=${lockPath}`,
    `--log=${logPath}`,
    `--app-log=${join(root, `${name}.app.log`)}`,
    `--shell=${DEAD_PID}`,
    `--host=${hostPid}`,
  ], { stdio: 'ignore', env })

  const started = Date.now()
  let settled = false
  while (Date.now() - started < timeoutMs) {
    if (until()) { settled = true; break }
    await sleep(200)
  }
  const exited = child.exitCode !== null
  if (!exited) child.kill()
  return { settled, exited, code: child.exitCode, elapsedMs: Date.now() - started }
}

// --- 1. nothing is serving: the guardian starts the app ------------------------

const dir1 = join(root, 'nothing-serving')
mkdirSync(dir1, { recursive: true })
const lock1 = join(dir1, 'relaunch.lock')
const log1 = join(dir1, 'guardian.log')
const marker1 = join(dir1, 'marker.txt')
// A lock left behind by a helper that died, naming a helper pid that is long gone.
writeFileSync(lock1, JSON.stringify({ at: new Date().toISOString(), started: Date.now(), helper: DEAD_PID, stage: 'starting' }))

const first = await runGuardian('nothing-serving', {
  // Nothing listens on this port: the app is simply not there.
  web: 'http://127.0.0.1:1',
  lockPath: lock1,
  logPath: log1,
  marker: marker1,
  until: () => read(marker1).trim().split('\n').filter(Boolean).length >= 1 && !existsSync(lock1),
})
assert.equal(first.settled, true, 'the guardian started the app and released the dead helper\'s lock')
assert.ok(read(marker1).trim().split('\n').filter(Boolean).length >= 1, 'the app was launched')
assert.match(read(marker1), /^launch node=$/m, 'and ELECTRON_RUN_AS_NODE was stripped from what it handed the app')
assert.match(read(log1), /starting the app \(attempt 1\)/, 'the log says the guardian had to act')
assert.match(read(log1), /helper pid=999999 gone/, 'and that the helper it was watching is gone')
assert.equal(existsSync(lock1), false, 'the lock is released, so the button works again')
console.log('1 nothing serving: the guardian started the app and cleared the dead lock')

// --- 2. an app is already serving: the guardian does nothing -------------------

const dir2 = join(root, 'already-serving')
mkdirSync(dir2, { recursive: true })
const lock2 = join(dir2, 'relaunch.lock')
const log2 = join(dir2, 'guardian.log')
const marker2 = join(dir2, 'marker.txt')
writeFileSync(lock2, JSON.stringify({ at: new Date().toISOString(), started: Date.now(), helper: DEAD_PID }))

const server = http.createServer((_request, response) => {
  response.statusCode = 401
  response.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const liveUrl = `http://127.0.0.1:${server.address().port}`

const second = await runGuardian('already-serving', {
  web: liveUrl,
  lockPath: lock2,
  logPath: log2,
  marker: marker2,
  until: () => read(log2).includes('the app is answering'),
})
assert.equal(second.settled, true, 'the guardian saw the app answering')
assert.equal(read(marker2), '', 'and started nothing at all')
assert.match(read(log2), /the app is answering after \d+ms/, 'it says so in its log')
assert.equal(existsSync(lock2), true, 'and it left a lock it did not need to touch alone')
console.log('2 already serving: the guardian stood down without launching anything')

// --- 3. the lock belongs to a restart that is still running --------------------
//
// This is the one that made two quick restarts dangerous: if the guardian released a lock whose owner
// was still working, the next click would start a second helper, and two helpers each closing a shell
// and starting an app is how a machine ends up stuck. The guardian still starts the app — it has no
// answer on the port — but the lock is not its to release.

const dir3 = join(root, 'live-owner')
mkdirSync(dir3, { recursive: true })
const lock3 = join(dir3, 'relaunch.lock')
const log3 = join(dir3, 'guardian.log')
const marker3 = join(dir3, 'marker.txt')
// This harness process stands in for a host that is still alive and still working.
writeFileSync(lock3, JSON.stringify({ at: new Date().toISOString(), started: Date.now(), helper: process.pid, stage: 'launching' }))

const third = await runGuardian('live-owner', {
  web: 'http://127.0.0.1:1',
  lockPath: lock3,
  logPath: log3,
  marker: marker3,
  hostPid: process.pid,
  until: () => read(marker3).trim() !== '',
})
assert.equal(third.settled, true, 'the guardian started the app even so')
assert.match(read(log3), /still running, stage=launching/, 'while saying the restart it was watching is alive')
assert.match(read(log3), /the lock still belongs to a live process; leaving it alone/, 'and leaving that lock alone')
assert.equal(existsSync(lock3), true, 'the lock survives, so a second click cannot start a second restart')
console.log('3 live owner: the app was started, and the live restart kept its lock')

server.close()
try { rmSync(root, { recursive: true, force: true }) } catch {}
console.log('')
console.log('RESULT: dsh-plugin-restart guardian starts the app when nothing else did — even with the')
console.log('        helper gone and its lock still on disk — stands down when an app is serving, and')
console.log('        never releases a lock that belongs to a restart still in progress')
process.exit(0)
