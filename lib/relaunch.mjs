/**
 * Detached relaunch helper.
 *
 * The host half runs as a plain Node child of the Electron shell, so it has no
 * `app.relaunch()` — and the shell holds a single-instance lock, so starting the app while it
 * lives would only re-focus the old window. This helper therefore outlives its parent:
 * it closes the shell, starts the app, and makes sure the user actually sees it again.
 *
 * Six details decide whether that works, each one forced by observed behaviour:
 *
 * - The shell is closed first, and the host only exits once the shell is gone (the host polls for
 *   the pid). The shell answers *any* host exit with a crash dialog and a crash report over a host
 *   that is already gone, so the two must not be seen in the other order.
 * - `ELECTRON_RUN_AS_NODE` is stripped before every launch (see `proc.mjs`): passed on to the app,
 *   it starts the Electron binary as a script-less Node process with no window.
 * - Nothing is killed that cannot be brought back: a missing or non-executable app path ends the
 *   restart before the shell is touched.
 * - The previous generation is gone before the next one starts. A killed shell can leave children
 *   behind for a moment; they hold the profile open, and an app that starts into a held profile is
 *   the classic way for a restart to end with no window at all.
 * - The app is started directly, so this helper owns its pid and can tell a real launch from one
 *   that lost the single-instance race and died — those are retried.
 * - The window is raised exactly once, after the app answers. The shell answers a second launch by
 *   focusing its own window; that is the only lever a plugin has, and it costs a whole Electron
 *   start, so it is not done three times.
 *
 * If this helper dies anyway, `guardian.mjs` — started by the host before this file — starts the app
 * instead. Neither process is the only thing standing between the user and a closed app.
 *
 * Everything it does is written to `relaunch.log`, the app's own output to `app.log`, and a
 * machine-readable summary of the last restart to `last-run.json` — all beside these arguments.
 *
 * argv: <appExecutable> <shellPid> <logPath> [--host=<pid>] [--web=<url>] [--lock=<path>]
 *       [--guardian=<pid>] — or, as an older Host passed them, those three followed positionally by
 *       <hostPid> <webUrl> <lockPath>. Both are accepted: the helper is read from disk at spawn time
 *       while the Host code was loaded at boot, so the first restart after an update really does run
 *       an older Host against a newer helper.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { alive, appProcesses, closePid, launchApp, launchable } from './proc.mjs'

const [appExe, shellPidText, logPath, ...rest] = process.argv.slice(2)

// Named arguments when the Host passes them, positional otherwise. Anything that does not look like
// what it claims to be is dropped: a URL that is not http(s) would otherwise cost a bounded but
// pointless 25-second poll, and a relative lock path would write into whatever the working directory
// happens to be.
const flags = new Map()
const positional = []
for (const argument of rest) {
  const match = /^--([a-z-]+)=(.*)$/s.exec(argument)
  if (match !== null) flags.set(match[1], match[2])
  else positional.push(argument)
}
const shellPid = Number(shellPidText)
const hostPid = Number(flags.get('host') ?? positional[0])
const guardianPid = Number(flags.get('guardian'))
const rawWeb = String(flags.get('web') ?? positional[1] ?? '') || String(process.env.DSH_WEB_URL ?? '')
const webUrl = /^https?:\/\//i.test(rawWeb) ? rawWeb : ''
const rawLock = String(flags.get('lock') ?? positional[2] ?? '')
const lockPath = rawLock !== '' && path.isAbsolute(rawLock) ? rawLock : ''

const dataDir = path.dirname(logPath)
const appLogPath = path.join(dataDir, 'app.log')
const lastRunPath = path.join(dataDir, 'last-run.json')
const imageName = path.basename(appExe)

const t0 = Date.now()
const marks = {}
const mark = (name) => { marks[name] = Date.now() - t0 }
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const log = (line) => {
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch {}
}

const version = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

let attempts = 0
let pokes = 0
let appExit = null
let straysClosed = 0
let schedule = []

/**
 * How long an instance needs either to lose the single-instance race and exit or to settle in as the
 * app. Chromium checks the lock within a few hundred milliseconds of starting; well under a second
 * later, "still running" means "this one owns the app".
 */
const LOCK_SETTLE_MS = 1200
const LAUNCH_ATTEMPTS = 3

/** How long the previous generation is given to disappear before what is left of it is closed. */
const STRAY_WAIT_MS = 5000

/**
 * How long a window-raising launch is given to hand over to the running instance and exit. It has no
 * window of its own to show, so anything past this is either the app itself or a stray.
 *
 * `DSH_RESTART_POKE_MS` overrides the delay before that single raise. It is deliberately late — after
 * the app has answered — so the raise lands on a window that exists instead of competing with the app's
 * own boot, which is exactly what three raises at 2/6/12 s used to do.
 */
const POKE_SETTLE_MS = 4000
const POKE_DELAY_MS = (() => {
  const configured = Number(process.env.DSH_RESTART_POKE_MS)
  return Number.isFinite(configured) && configured >= 0 && configured <= 60000 ? configured : 4000
})()

/**
 * How long the app must keep answering before this restart counts as over and the lock is released.
 *
 * The lock is what keeps a second click from killing an app that is still starting: two restarts a few
 * seconds apart mean the second one terminates an app in the middle of its boot, which is how a restart
 * ends up looking stuck. The window is measured **from the moment the app answers**, and the raise
 * happens inside it, so the lock is held for this long rather than for this long plus the raise. Holding
 * it longer would be a lie in the button's own words — "the app is still starting" — about an app that
 * has been up for seconds. `DSH_RESTART_SETTLE_MS` overrides it.
 */
const SETTLE_MS = (() => {
  const configured = Number(process.env.DSH_RESTART_SETTLE_MS)
  return Number.isFinite(configured) && configured >= 0 && configured <= 120000 ? configured : 6000
})()

/** How long the browser is given to paint "restarting" before its window is taken away. */
const NOTICE_MS = 100

/**
 * Whether to raise the window by starting the app a second time.
 *
 * Off by default: it costs a whole Electron start, it lands while the app's own UI is still loading, and
 * a freshly started app shows its own window anyway. `DSH_RESTART_RAISE=1` turns it back on for a machine
 * where the restored window really does come up behind something else — and the page itself asks for a
 * plain `window.focus()` when it mounts after a restart, which costs nothing at all.
 */
const RAISE = /^(1|true|yes)$/i.test(String(process.env.DSH_RESTART_RAISE ?? ''))

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
 * Close one pid and confirm it is gone, with a second attempt — a process that survives the first
 * kill is exactly what would leave the restarted app staring at a held single-instance lock, or its
 * host at a taken port.
 */
async function closeAndWait(pid, why, ms) {
  for (let attempt = 1; attempt <= 2 && alive(pid); attempt += 1) {
    closePid(pid, attempt === 1 ? why : `${why} (retry)`, log)
    await awaitGone(pid, ms)
  }
  log(`after kill ${why} pid=${pid} alive=${alive(pid)}`)
  return !alive(pid)
}

/**
 * Wait for the previous generation to be gone, then close what is left of it.
 *
 * A killed Electron shell can leave children behind for a moment — renderers, GPU helpers, the node
 * host this helper already chased down. They hold the profile open, and an app that starts into a
 * held profile is the classic way for a restart to end with no window at all. Everything running the
 * app's image is therefore accounted for before the next launch, except this helper, the guardian,
 * the host being replaced, and the shell being closed.
 *
 * The first enumeration is *started* before the shell is closed: `tasklist` needs a few hundred
 * milliseconds to start on Windows and the shell needs about as long to die, so the two overlap and the
 * scan costs almost nothing on the critical path. Doing it the other way round — scanning after the
 * close, as 0.2.0 did — put those few hundred milliseconds straight onto the user's clock.
 *
 * @param scanned - Pids seen before the launch; anything in there that is still alive afterwards is by
 *   definition not the app this helper is starting.
 */
async function clearStrays(scanned) {
  const excluded = new Set(
    [process.pid, shellPid, hostPid, guardianPid].filter((pid) => Number.isFinite(pid) && pid > 0),
  )
  const seen = (await scanned).filter((pid) => !excluded.has(pid))
  const deadline = Date.now() + STRAY_WAIT_MS
  const started = Date.now()
  for (;;) {
    const strays = seen.filter((pid) => alive(pid))
    if (strays.length === 0) return Date.now() - started
    if (Date.now() >= deadline) {
      for (const pid of strays) if (closePid(pid, 'stray app process', log)) straysClosed += 1
      await sleep(300)
      return Date.now() - started
    }
    await sleep(250)
  }
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
 * Start the app and prove the start took.
 *
 * A launch that loses the single-instance race exits almost immediately, which is the only failure
 * this can detect from outside — and the one that matters, because it happens when the old shell has
 * not finished releasing the lock. Those are retried; the app's exit code is recorded either way.
 * @returns The surviving child, or undefined when every attempt died.
 */
async function launchWithRetries() {
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    attempts = attempt
    let child
    try {
      child = launchApp(appExe, appLogPath)
    } catch (error) {
      log(`launch attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    if (attempt === 1) mark('launched')
    log(`launch attempt ${attempt}: pid=${child.pid}`)

    if (!(await exitedWithin(child, LOCK_SETTLE_MS))) return child
    appExit = child.exitCode
    log(`launch attempt ${attempt} exited immediately (code ${child.exitCode}); the single-instance lock was probably still held`)
    if (attempt < LAUNCH_ATTEMPTS) await sleep(250)
  }
  return undefined
}

/**
 * Ask the running instance to bring its window to the front, once.
 *
 * The shell answers a second launch by focusing its own window (`second-instance`) — the only lever a
 * plugin has on window visibility. It costs a whole Electron start, so it happens once, late enough
 * to land after the app is in its workspace; and if it lingers after handing over while the app this
 * helper started is still alive, it is closed again rather than left as a second instance.
 */
async function raise(appPid) {
  let child
  try {
    child = launchApp(appExe)
  } catch (error) {
    log(`raise failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  pokes += 1
  log(`poked the app (raise) pid=${child.pid}`)
  if (await exitedWithin(child, POKE_SETTLE_MS)) return
  if (alive(appPid)) {
    log(`poke ${child.pid} did not exit and the app is running; closing it`)
    closePid(child.pid, 'stray poke', log)
  } else {
    log(`poke ${child.pid} is still running and the app this helper started is gone; leaving it alone`)
  }
}

function writeLock(stage, extra = {}) {
  if (lockPath === '') return
  try {
    fs.writeFileSync(lockPath, JSON.stringify({
      at: new Date().toISOString(),
      started: t0,
      helper: process.pid,
      guardian: Number.isFinite(guardianPid) ? guardianPid : null,
      shellPid,
      hostPid,
      stage,
      ...extra,
    }))
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
    straysClosed,
    appExit,
    version,
    gaps: schedule,
    ms: { ...marks, total: Date.now() - t0 },
  }
  try { fs.writeFileSync(lastRunPath, `${JSON.stringify(summary, undefined, 2)}\n`) } catch {}
  const timeline = Object.entries(marks).map(([name, value]) => `${name}=${value}ms`).join(' ')
  log(`done ok=${ok} answered=${answered} attempts=${attempts} pokes=${pokes} straysClosed=${straysClosed} appExit=${appExit} ${timeline} total=${summary.ms.total}ms`)
}

log(`start v=${version} app=${appExe} shell=${shellPid} host=${hostPid} guardian=${guardianPid} web=${webUrl === '' ? '(none)' : webUrl} lock=${lockPath === '' ? '(none)' : lockPath}`)
writeLock('starting')

// 0. Never close a shell that cannot be replaced.
if (!launchable(appExe)) {
  log(`app executable is missing or not an executable image: ${appExe} — leaving the running app alone`)
  finish(false, false)
  process.exit(1)
}

// 1. Start the process enumeration now, let the restart answer reach the browser, then close the shell —
//    the shell must go first, because it reports any host exit as a crash (see the header). The scan and
//    the close overlap on purpose: neither is faster than the other, and only one of them is the user's
//    to wait for.
const strayScan = appProcesses(imageName)
await sleep(NOTICE_MS)
if (alive(shellPid)) await closeAndWait(shellPid, 'shell', 1200)
else log('shell already gone')
mark('shellGone')

// 2. Start the app — the only step the user is actually waiting for, so nothing is allowed in front of
//    it. The enumeration started above is deliberately *not* awaited here: it was taken before this
//    launch, so anything from it that is still alive afterwards cannot be the app being started.
const app = await launchWithRetries()
if (app === undefined) {
  log('every launch attempt died; leaving the app to the guardian')
  finish(false, false)
  process.exit(1)
}
mark('appStarted')

// 3. The old host owns the web port and the profile; it leaves on its own within about a tenth of a
//    second of the shell dying, so this is confirmed *after* the launch rather than waited on before
//    it — that wait used to sit on the user's clock, and the new app needs several seconds before its
//    own host binds the port.
if (alive(hostPid)) await closeAndWait(hostPid, 'host', 1200)
else log('host already gone')
mark('hostGone')

// 4. Now clear what is left of the previous generation (in the ordinary case: nothing). A killed
//    Electron shell can leave children behind for a moment, and they hold the profile open — the classic
//    way for a restart to end with a running process and no window. Doing this *after* the launch costs
//    nothing the user can feel; doing it before cost every restart a few hundred milliseconds of process
//    enumeration, which is exactly what 0.2.0 and 0.3.x did.
const strayWait = await clearStrays(strayScan)
mark('clean')

// 5. Wait for the app to serve, optionally raise its window, and stay out of its way until it settles.
let answered = false
if (webUrl !== '') {
  answered = await awaitServer(webUrl, 25000)
  log(`web ${webUrl} answering=${answered}`)
  if (!answered) log('the app did not answer; the guardian will start it if this helper is wrong')
} else {
  log('no web address was passed; waiting out a boot instead')
}
mark('appUp')

if (answered || webUrl === '') {
  // Hold the lock until the app has kept answering for SETTLE_MS, measured from here, so a click a couple
  // of seconds later is told to wait rather than killing an app that is still starting. The lock says so
  // itself (`settleUntil`), which is also what keeps it from wedging the button if this helper never gets
  // to release it.
  const settleUntil = Date.now() + SETTLE_MS
  if (SETTLE_MS > 0) writeLock('settling', { appPid: app.pid, settleUntil, answered })

  // Raising the window means starting a whole second Electron and letting the shell hand the focus to
  // the instance the user is looking at — measured cost, at the worst possible moment: the app's own UI
  // is still loading then. A freshly started app shows its own window, so this is off unless asked for;
  // the page asks for a plain `window.focus()` itself instead, which costs nothing.
  if (RAISE) {
    await sleep(POKE_DELAY_MS)
    schedule = [POKE_DELAY_MS]
    await raise(app.pid)
  } else {
    log('window raise is off (DSH_RESTART_RAISE=1 turns it back on)')
  }

  const remaining = settleUntil - Date.now()
  if (remaining > 0) {
    log(`holding the lock ${remaining}ms more while the app settles`)
    await sleep(remaining)
  }
  mark('settled')
}

log(`the previous generation took ${strayWait}ms to clear`)
finish(app !== undefined && (answered || webUrl === ''), answered)
process.exit(0)
