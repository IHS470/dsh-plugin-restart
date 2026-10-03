/**
 * Detached relaunch helper.
 *
 * The host half runs as a plain Node child of the Electron shell, so it has no
 * `app.relaunch()` — and the shell holds a single-instance lock, so starting the app while
 * it lives would only re-focus the old window. This helper therefore outlives its parent:
 * it closes the shell, waits for the host to leave, then starts the app again.
 *
 * Five details decide whether the user sees the app come back:
 *
 * - The shell is closed first, and the host only exits once the shell is gone (the host polls
 *   for the pid). The shell answers *any* host exit with a crash dialog and a crash report
 *   over a host that is already gone, so the two must not be seen in the other order.
 * - The app is started through `start`, the same way Explorer starts it, instead of being
 *   spawned as this helper's child. The new process then owns a normal, visible window and
 *   sits outside the old process tree — which matters because the fallback below kills by
 *   pid, and a tree kill would take this helper down before it could relaunch anything.
 * - If nothing ever answers on the web port, the friendly launch did not take, and the
 *   executable is spawned directly (how this helper used to do it) as a second chance.
 * - Once the new host answers, the app is started once more: the shell answers a second
 *   launch by focusing its own window (`second-instance`), so the restarted app comes to
 *   the front instead of waiting behind whatever the user is doing.
 * - `ELECTRON_RUN_AS_NODE` — how the shell runs the host as Node — is stripped before every
 *   launch: passed on to the app it starts the Electron binary as a script-less Node process
 *   that opens no window and exits.
 *
 * argv: <appExecutable> <shellPid> <logPath> [hostPid] [webUrl]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'

const [appExe, pidText, logPath, hostPidText, webText] = process.argv.slice(2)
const shellPid = Number(pidText)
const hostPid = Number(hostPidText)
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const log = (line) => {
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch {}
}

/**
 * The environment the app must be started with — the Host's, minus `ELECTRON_RUN_AS_NODE`.
 *
 * That variable is how the desktop shell runs the dsh host as plain Node, so this helper
 * inherits it from its parent. Passing it on to the app starts the Electron binary as a
 * script-less Node process: it opens no window and exits, and the user sees exactly "the app
 * closed and never came back". The old helper deleted it and the rewrite dropped that; it is
 * kept for every launch path here.
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

/** Start the app the way the user does, so it gets its own visible window. */
function launch() {
  const child = spawn('cmd.exe', ['/c', 'start', '""', `"${appExe}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
    env: launchEnv,
  })
  child.unref()
  return child.pid
}

/** Start the executable directly; the last resort when `start` does not take. */
function launchDirect() {
  const child = spawn(appExe, [], { detached: true, stdio: 'ignore', env: launchEnv })
  child.unref()
  return child.pid
}

/** Wait for a pid to disappear, bounded. */
async function awaitGone(pid, ms) {
  let waited = 0
  while (waited < ms && alive(pid)) {
    await sleep(100)
    waited += 100
  }
  return waited
}

/**
 * Close one pid and confirm it is gone, with a second attempt — a process that survives the
 * first kill is exactly what would leave the restarted app staring at a held single-instance
 * lock (and the user staring at a tray icon).
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

log(`start app=${appExe} shell=${shellPid} host=${hostPid}`)

// 1. The shell goes first, and that order is the whole point: the shell reports *any* host exit
//    as a crash — a clean `process.exit(0)` included — and puts 「应用无法启动或已意外停止」 with the
//    host's stderr tail over a host that is already gone. The Host does its part by waiting for
//    this pid to disappear before it exits, so closing the shell here is what keeps that dialog
//    off the screen. The pause is only to stay behind the restart answer the browser was just
//    sent (and, for a host still running older code that exits on its own 400 ms timer, ahead
//    of it — the shell's dialog shows up about 20 ms after the host does).
await sleep(200)
if (alive(shellPid)) {
  await closeAndWait(shellPid, 'shell', 1500)
} else {
  log('shell already gone')
}

// 2. The Host exits by itself once the shell is gone; it owns the profile, so it is the one
//    process that is not interrupted. Only a Host that overstays its own bound is closed.
if (alive(hostPid)) {
  const waited = await awaitGone(hostPid, 5000)
  if (alive(hostPid)) {
    log(`host still up after ${waited}ms`)
    await closeAndWait(hostPid, 'host', 1500)
  } else {
    log(`host exited after ${waited}ms`)
  }
} else {
  log('host already gone')
}

// 3. The single-instance lock is released a moment after the process goes away.
await sleep(400)
try {
  log(`launcher pid=${launch()}`)
} catch (error) {
  log(`relaunch failed: ${error instanceof Error ? error.message : String(error)}`)
}

// 4. Bring the window to the front: launch the app once more, because the shell answers a
//    second launch by focusing its own window (`second-instance`) — the only lever a plugin has
//    on window visibility. Timing is what makes it land, so wait for the app to answer on the
//    address the Host passed, or out a conservative boot when the Host had none to pass.
//    An answer can also come from a host that has not shown its window yet (the shell ignores
//    the poke until the app is in its workspace), hence two pokes with room in between.
const url = (typeof webText === 'string' && webText !== '' ? webText : process.env.DSH_WEB_URL) || ''
let up = false
if (url !== '') {
  up = await awaitServer(url, 25000)
  if (!up) {
    log('no answer after 25000ms; starting the executable directly')
    try {
      log(`direct pid=${launchDirect()}`)
    } catch (error) {
      log(`direct launch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    up = await awaitServer(url, 25000)
  }
  log(`web ${url} answering=${up}`)
} else {
  log('no web address was passed; waiting out a boot instead')
}

/** One poke, logged with what it was for. */
function raise(tag) {
  try {
    launch()
    log(`raised the window ${tag}`)
  } catch (error) {
    log(`raise failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await sleep(up ? 1500 : 6000)
raise('once')
await sleep(4000)
raise('twice')
log('done')
