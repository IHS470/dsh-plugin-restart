/**
 * The restart's witness.
 *
 * A restart is performed by `relaunch.mjs`: it closes the desktop shell, waits for the old host to
 * leave, and starts the app again. If that helper dies in between — killed, the machine suspends, a
 * security tool intervenes, the launch itself fails — the app stays closed, and the only way back
 * is the desktop shortcut. That is the one outcome this plugin must not have.
 *
 * So the host starts this guardian *before* it starts the helper. The guardian outlives both and
 * does one thing: if the app has not answered on its web port by the time a restart should have
 * finished, it starts the app itself, repeating a few times. It is deliberately blunt, because it
 * is the code that runs when everything else has already gone wrong: no state of its own, nothing
 * to clean up, and any failure ends in a log line rather than in a hung process.
 *
 * argv: <appExecutable> --web=<url> --lock=<path> --log=<path> --app-log=<path> --shell=<pid>
 *      [--host=<pid>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { alive, appProcesses, launchApp, closePid } from './proc.mjs'

const [appExe, ...rest] = process.argv.slice(2)
const flags = new Map()
for (const argument of rest) {
  const match = /^--([a-z-]+)=(.*)$/s.exec(argument)
  if (match !== null) flags.set(match[1], match[2])
}
const rawWeb = String(flags.get('web') ?? '')
const webUrl = /^https?:\/\//i.test(rawWeb) ? rawWeb : ''
const rawLock = String(flags.get('lock') ?? '')
const lockPath = rawLock !== '' && path.isAbsolute(rawLock) ? rawLock : ''
const logPath = String(flags.get('log') ?? path.join(path.dirname(lockPath === '' ? '.' : lockPath), 'guardian.log'))
const appLogPath = String(flags.get('app-log') ?? '') || undefined
const shellPid = Number(flags.get('shell'))
const hostPid = Number(flags.get('host'))

/**
 * How long a restart may take before the guardian stops believing in it.
 *
 * A restart measures about 15 seconds end to end (close the shell, start the app, wait for the first
 * answer, raise the window). The grace is long enough to leave a working helper alone and short enough
 * that a user who has been staring at nothing gets an app back. `DSH_RESTART_GUARDIAN_GRACE_MS`
 * overrides it for a machine whose app takes much longer — and for the test harness, which must not sit
 * through twenty-five seconds to watch something it can watch in two.
 */
const GRACE_MS = (() => {
  const configured = Number(process.env.DSH_RESTART_GUARDIAN_GRACE_MS)
  return Number.isFinite(configured) && configured >= 500 && configured <= 600000 ? configured : 25_000
})()
const POLL_MS = 2_000
const ATTEMPTS = 3
const GAP_MS = 12_000
const LIFETIME_MS = 180_000

const started = Date.now()
const log = (line) => {
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch {}
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Any answer means a host is serving; the old one is gone by the time the shell is. */
async function answering() {
  if (webUrl === '') return false
  try {
    const response = await fetch(webUrl, { signal: AbortSignal.timeout(3000) })
    return response.status > 0
  } catch {
    return false
  }
}

/**
 * What the lock on disk says, if anything: whose restart it is and which app that restart started.
 *
 * Used only to tell a restart that is still progressing from one that has been abandoned — and to leave
 * the launched app alone when the guardian goes looking for strays.
 */
function lockState() {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    return { helper: Number(lock?.helper) || 0, appPid: Number(lock?.appPid) || 0, stage: lock?.stage ?? null }
  } catch {
    return { helper: 0, appPid: 0, stage: null }
  }
}

const imageName = path.basename(appExe)
log(`start app=${appExe} shell=${shellPid} host=${hostPid} web=${webUrl === '' ? '(none)' : webUrl} lock=${lockPath === '' ? '(none)' : lockPath}`)

// The shell has to go before anything can be judged: while it lives, the old host may still be
// answering its port and a "the app is back" reading would be a lie.
for (let waited = 0; waited < 10_000 && alive(shellPid); waited += 200) await sleep(200)
log(alive(shellPid) ? 'the shell is still running; watching anyway' : 'the shell is gone')

let attempts = 0
let ok = false
while (Date.now() - started < LIFETIME_MS) {
  if (await answering()) {
    ok = true
    log(`the app is answering after ${Date.now() - started}ms${attempts > 0 ? ` (the guardian started it ${attempts}x)` : ''}`)
    break
  }
  if (Date.now() - started < GRACE_MS) {
    await sleep(POLL_MS)
    continue
  }
  if (attempts >= ATTEMPTS) {
    log(`the app still is not answering after ${Date.now() - started}ms and ${attempts} attempts; giving up`)
    break
  }
  attempts += 1
  const lock = lockState()
  const ownerAlive = alive(lock.helper) || alive(hostPid)
  log(`no answer after ${Date.now() - started}ms (helper pid=${lock.helper} ${ownerAlive ? 'still running' : 'gone'}, stage=${lock.stage ?? 'none'}); starting the app (attempt ${attempts})`)
  // The lock of a restart that is still progressing is left alone: clearing it would let a second click
  // start a second helper, and two helpers each closing shells and starting apps is exactly the way to
  // make a couple of quick restarts end in a stuck machine. An abandoned lock is another matter — it
  // would only make the button answer `busy` to a user who has nothing to restart.
  if (lockPath !== '') {
    if (ownerAlive) log('the lock still belongs to a live process; leaving it alone')
    else { try { fs.rmSync(lockPath, { force: true }) } catch {} }
  }
  // Anything of the previous generation that outlived its shell would fight the new app for the
  // profile; it is not the app we are about to start (nor the one the helper already did), so it goes.
  for (const pid of await appProcesses(imageName)) {
    if (pid === hostPid || pid === lock.helper || pid === lock.appPid) continue
    closePid(pid, 'guardian: stray app process', log)
  }
  try {
    const child = launchApp(appExe, appLogPath)
    log(`guardian: started the app pid=${child.pid}`)
  } catch (error) {
    log(`guardian: could not start the app: ${error instanceof Error ? error.message : String(error)}`)
  }
  await sleep(GAP_MS)
}

log(`done ok=${ok} attempts=${attempts} total=${Date.now() - started}ms`)
process.exit(ok ? 0 : 1)
