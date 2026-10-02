/**
 * Detached relaunch helper.
 *
 * The host half runs as a plain Node child of the Electron shell, so it has no
 * `app.relaunch()` — and the shell holds a single-instance lock, so starting the app while it
 * lives would only re-focus the old window. This helper therefore outlives its parent:
 * it closes the shell, starts the app, and makes sure the user actually sees it again.
 *
 * Five details decide whether that works, each one forced by observed behaviour:
 *
 * - The shell is closed first, and the host only exits once the shell is gone (the host polls
 *   for the pid). The shell answers *any* host exit with a crash dialog and a crash report over
 *   a host that is already gone, so the two must not be seen in the other order.
 * - `ELECTRON_RUN_AS_NODE` — how the shell runs the host as Node — is stripped before every
 *   launch: passed on to the app it starts the Electron binary as a script-less Node process
 *   that opens no window and exits.
 * - Nothing is killed that cannot be brought back: a missing executable ends the restart before
 *   the shell is touched.
 * - The app is started directly (not through `cmd`), so this helper owns its pid and can tell a
 *   real launch from one that lost the single-instance race and died — those are retried.
 * - The app is started once more after it answers, because the shell answers a second launch by
 *   focusing its own window (`second-instance`) — the only lever a plugin has on window
 *   visibility. Poking is self-healing too: if the first instance is gone, the poke becomes it.
 *
 * Everything it does is written to `relaunch.log`, the app's own output to `app.log`, and a
 * machine-readable summary of the last restart to `last-run.json` — all beside these arguments.
 *
 * argv: <appExecutable> <shellPid> <logPath> [--host=<pid>] [--web=<url>] [--lock=<path>]
 *       — or, as an older Host passed them, those three followed positionally by
 *       <hostPid> <webUrl> <lockPath>. Both are accepted: the helper is read from disk at spawn
 *       time while the Host code was loaded at boot, so the first restart after an update really
 *       does run an older Host against a newer helper.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const [appExe, shellPidText, logPath, ...rest] = process.argv.slice(2)

// Named arguments when the Host passes them, positional otherwise. Anything that does not look
// like what it claims to be is dropped: a URL that is not http(s) would otherwise cost a bounded
// but pointless 25-second poll, and a relative lock path would write into whatever the working
// directory happens to be.
const flags = new Map()
const positional = []
for (const argument of rest) {
  const match = /^--([a-z]+)=(.*)$/s.exec(argument)
  if (match) flags.set(match[1], match[2])
  else positional.push(argument)
}
const shellPid = Number(shellPidText)
const hostPid = Number(flags.get('host') ?? positional[0])
const rawWeb = String(flags.get('web') ?? positional[1] ?? '') || String(process.env.DSH_WEB_URL ?? '')
const webUrl = /^https?:\/\//i.test(rawWeb) ? rawWeb : ''
const rawLock = String(flags.get('lock') ?? positional[2] ?? '')
const lockPath = rawLock !== '' && path.isAbsolute(rawLock) ? rawLock : ''

const dataDir = path.dirname(logPath)
const appLogPath = path.join(dataDir, 'app.log')
const lastRunPath = path.join(dataDir, 'last-run.json')

const t0 = Date.now()
const marks = {}
const mark = (name) => { marks[name] = Date.now() - t0 }
let attempts = 0
let pokes = 0
let appExit = null
let schedule = []

const version = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const log = (line) => {
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch {}
}

/**
 * The environment the app must be started with — the Host's, minus `ELECTRON_RUN_AS_NODE`.
 *
 * That variable is how the desktop shell runs the dsh host as plain Node, so this helper
 * inherits it from its parent. Passing it on to the app starts the Electron binary as a
 * script-less Node process: no window, instant exit, and the user sees exactly "the app closed
 * and never came back".
 */
const launchEnv = { ...process.env }
delete launchEnv.ELECTRON_RUN_AS_NODE

/** Access-denied still means the process exists. */
const alive = (pid) => {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}

/**
 * One process, by pid — never the tree: this helper is a grandchild of the shell
 * (shell → host → here), so `taskkill /T` would kill the helper mid-restart.
 */
const kill = (pid, why) => {
  log(`${why}: closing pid ${pid}`)
  try {
    spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
  } catch (error) {
    log(`taskkill ${pid} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Wait for a pid to disappear, bounded. */
async function awaitGone(pid, ms, step = 60) {
  let waited = 0
  while (waited < ms && alive(pid)) {
    await sleep(step)
    waited += step
  }
  return waited
}

/**
 * Close one pid and confirm it is gone, with a second attempt — a process that survives the
 * first kill is exactly what would leave the restarted app staring at a held single-instance
 * lock, or its host at a taken port.
 */
async function closeAndWait(pid, why, ms) {
  for (let attempt = 1; attempt <= 2 && alive(pid); attempt += 1) {
    kill(pid, attempt === 1 ? why : `${why} (retry)`)
    await awaitGone(pid, ms)
  }
  log(`after kill ${why} pid=${pid} alive=${alive(pid)}`)
  return !alive(pid)
}

/** Whether the app already answers on its web port. */
function answering(url) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const request = http.get(url, { timeout: 1500 }, (response) => {
        response.resume()
        // Any answer means the server is up; 401 is the ordinary one here.
        done(true)
      })
      request.on('timeout', () => { request.destroy(); done(false) })
      request.on('error', () => done(false))
    } catch {
      done(false)
    }
  })
}

/** Poll the web port until the restarted app serves, bounded. */
async function awaitServer(url, ms) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (await answering(url)) return true
    await sleep(500)
  }
  return false
}

/** The app's own output, rewritten on every restart: one boot per file, and enough to read one. */
function openAppLog() {
  try {
    return fs.openSync(appLogPath, 'w')
  } catch (error) {
    log(`cannot open ${appLogPath}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Resolves true when the child exited within `ms` — a loser of the single-instance race does. */
function exitedWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * How long an instance needs either to lose the single-instance race and exit or to settle in as
 * the app. Chromium checks the lock within a few hundred milliseconds of starting; well under a
 * second later, "still running" means "this one owns the app".
 */
const LOCK_SETTLE_MS = 1200
const LAUNCH_ATTEMPTS = 3

/**
 * Start the app and prove the start took.
 *
 * A launch that loses the single-instance race exits almost immediately, which is the only
 * failure this can detect from outside — and the one that matters, because it happens when the
 * old shell has not finished releasing the lock. Those are retried; the app's exit code is
 * recorded either way.
 * @returns The surviving child, or undefined when every attempt died.
 */
async function launchApp() {
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    attempts = attempt
    const fd = openAppLog()
    let child
    try {
      child = spawn(appExe, [], {
        detached: true,
        stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd],
        env: launchEnv,
        windowsHide: true,
      })
    } catch (error) {
      log(`launch attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (fd !== undefined) try { fs.closeSync(fd) } catch {}
      return undefined
    }
    child.unref()
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
    if (attempt === 1) mark('launched')
    log(`launch attempt ${attempt}: pid=${child.pid}`)

    if (!(await exitedWithin(child, LOCK_SETTLE_MS))) return child
    appExit = child.exitCode
    log(`launch attempt ${attempt} exited immediately (code ${child.exitCode}); the single-instance lock was probably still held`)
    if (attempt < LAUNCH_ATTEMPTS) await sleep(250)
  }
  return undefined
}

/** Launch the executable once more; the running instance focuses its window and this one exits. */
function poke(tag) {
  try {
    const child = spawn(appExe, [], { detached: true, stdio: 'ignore', env: launchEnv, windowsHide: true })
    child.unref()
    pokes += 1
    log(`poked the app (${tag}) pid=${child.pid}`)
    return true
  } catch (error) {
    log(`poke failed (${tag}): ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * When to poke the app, as the gaps between pokes.
 *
 * The default schedule spans a normal boot: the first poke lands well after the window is up, the
 * last one still lands while a slow machine is settling. `DSH_RESTART_POKE_MS` overrides it
 * (comma-separated millisecond gaps, at most 6) for a machine whose boot is unusually slow or
 * fast — and for the test harness, which must not sit through twelve seconds per scenario.
 */
function pokeSchedule(answered) {
  const configured = String(process.env.DSH_RESTART_POKE_MS ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 60000)
    .slice(0, 6)
  if (configured.length > 0) return configured
  return answered ? [2000, 4000, 6000] : [6000, 6000, 6000]
}

/**
 * Whether the app can actually be started.
 *
 * It is launched directly — no `cmd` in between, so this helper owns its pid and can tell a real
 * launch from one that lost the single-instance race. That also means it must be an executable
 * image: `spawn` refuses a `.cmd`/`.bat` with EINVAL, and closing the shell first would then leave
 * the user with no app at all. A missing file and a script both end the restart before anything
 * is closed.
 */
function launchable(exe) {
  return /\.exe$/i.test(exe) && fs.existsSync(exe)
}

function writeLock(stage) {
  if (lockPath === '') return
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ at: new Date().toISOString(), started: t0, helper: process.pid, shellPid, hostPid, stage }))
  } catch {}
}

function clearLock() {
  if (lockPath === '') return
  try { fs.rmSync(lockPath, { force: true }) } catch {}
}

let finished = false

/** Publish the outcome once — the summary the Host reads back, and the lock release. */
function finish(ok, answered) {
  if (finished) return
  finished = true
  clearLock()
  const summary = {
    at: new Date().toISOString(),
    ok,
    answered,
    attempts,
    pokes,
    appExit,
    version,
    gaps: schedule,
    ms: { ...marks, total: Date.now() - t0 },
  }
  try { fs.writeFileSync(lastRunPath, `${JSON.stringify(summary, undefined, 2)}\n`) } catch {}
  const timeline = Object.entries(marks).map(([name, value]) => `${name}=${value}ms`).join(' ')
  log(`done ok=${ok} answered=${answered} attempts=${attempts} pokes=${pokes} appExit=${appExit} ${timeline} total=${summary.ms.total}ms`)
}

log(`start v=${version} app=${appExe} shell=${shellPid} host=${hostPid} web=${webUrl === '' ? '(none)' : webUrl} lock=${lockPath === '' ? '(none)' : lockPath}`)
writeLock('starting')

// 0. Never close a shell that cannot be replaced.
if (!launchable(appExe)) {
  log(`app executable is missing or not an executable image: ${appExe} — leaving the running app alone`)
  finish(false, false)
  process.exit(1)
}

// 1. Let the restart answer reach the browser, then close the shell — the shell must go first,
//    because it reports any host exit as a crash (see the header).
await sleep(100)
if (alive(shellPid)) await closeAndWait(shellPid, 'shell', 1200)
else log('shell already gone')
mark('shellGone')

// 2. Start the app the moment the shell is gone. The old host is *not* waited for here: it exits
//    on its own within about a tenth of a second, and the new app needs several seconds before
//    its own host binds the port, so waiting was pure serial latency on the user's clock.
const app = await launchApp()
if (app === undefined) {
  log('every launch attempt died; the app is not running')
  finish(false, false)
  process.exit(1)
}
mark('appStarted')

// 3. Confirm the old host is gone — it owns the web port and the profile.
if (alive(hostPid)) await closeAndWait(hostPid, 'host', 1200)
else log('host already gone')
mark('hostGone')

// 4. Wait for the app to serve, then bring its window to the front.
let answered = false
if (webUrl !== '') {
  answered = await awaitServer(webUrl, 25000)
  if (!answered) {
    log('the app did not answer; poking once in case the first instance never took the lock')
    poke('self-heal')
    answered = await awaitServer(webUrl, 15000)
  }
  log(`web ${webUrl} answering=${answered}`)
} else {
  log('no web address was passed; waiting out a boot instead')
}
mark('appUp')

// An answer can come from a host that has not shown its window yet (the shell ignores the poke
// until the app is in its workspace), hence several pokes spread across a boot.
const gaps = pokeSchedule(answered)
schedule = gaps
for (const gap of gaps) {
  await sleep(gap)
  if (!poke('raise')) break
}

finish(app !== undefined && (answered || webUrl === ''), answered)
process.exit(0)
