/**
 * dsh-plugin-restart — host half.
 *
 * One job: restart the desktop app in a way the user actually sees. The window goes away, the
 * app comes back, and the window is in front — no crash dialog, no tray icon to hunt for.
 *
 *   GET  /dsh-restart/state     whether a desktop shell was found behind this host
 *   POST /dsh-restart/restart   close the shell, wait for this host to exit, start the app again
 *
 * Why it takes a helper process at all: the desktop shell runs this host as a plain Node child
 * (`dsh-desktop-host`), so `require('electron')` here has no `app` to relaunch with, and the
 * shell holds a single-instance lock — starting the app while the shell lives would only focus
 * the old window. So the restart is: a detached helper closes the shell, this host notices and
 * exits, the helper starts the app again. See `lib/relaunch.mjs` and the README.
 *
 * The plugin is stateless: nothing is written to disk except the helper's log under
 * `$DSH_HOME/dsh-plugin-restart/relaunch.log`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, readSettings, writeSettings } from './settings.mjs'
import { scriptRuntime } from './proc.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'restart'

/** Required host services: the routes live on the web server. */
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')

const ROUTE_PREFIX = '/dsh-restart'
const DATA_DIR = path.join(DSH_HOME, 'dsh-plugin-restart')
const RELAUNCH_LOG = path.join(DATA_DIR, 'relaunch.log')
const GUARDIAN_LOG = path.join(DATA_DIR, 'guardian.log')
const APP_LOG = path.join(DATA_DIR, 'app.log')
const LOCK_FILE = path.join(DATA_DIR, 'relaunch.lock')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const LAST_RUN_FILE = path.join(DATA_DIR, 'last-run.json')
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** This package's version, straight from its manifest — the state route reports it. */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * How long this host waits for the desktop shell to disappear before quitting anyway, and how
 * often it looks. The helper closes the shell within about half a second; the bound is the
 * fallback for a helper that never arrived, where the shell's own recovery dialog at least
 * offers the restart the user asked for.
 */
const SHELL_EXIT_TIMEOUT_MS = 4_000
const SHELL_EXIT_POLL_MS = 100

/**
 * How long a restart lock stays meaningful. The helper that owns one removes it when it is done;
 * the window is what keeps a crashed or killed helper from blocking every later restart forever.
 */
const LOCK_TTL_MS = 3 * 60 * 1000

/**
 * The desktop shell runs this host as a plain Node child — so `require('electron')` has no
 * `app` to relaunch with — and holds a single-instance lock, so starting the app again while
 * it lives would only focus the old window. What identifies a restartable app is therefore the
 * executable plus the parent that owns it; the detached helper does the relaunching.
 *
 * Windows only, and not because of the shell detection: the helper closes and starts the app with
 * `taskkill` and a direct launch, and its timing assumes the Windows single-instance behaviour.
 * Offering the button where it cannot work would mean closing a shell that never comes back, so
 * elsewhere the route answers `unavailable` instead.
 */
function desktopShell() {
  if (process.platform !== 'win32') return undefined
  const exe = process.execPath
  if (typeof exe !== 'string' || exe === '') return undefined
  if (!/DeepSeek Harness|dsh-desktop|Electron/i.test(path.basename(exe))) return undefined
  // A shell whose executable has been moved, uninstalled or replaced by a script must not be
  // closed either: the helper launches the executable directly.
  if (!(/\.exe$/i.test(exe) && fs.existsSync(exe))) return undefined
  const parent = process.ppid
  if (!Number.isFinite(parent) || parent <= 0) return undefined
  return { exe, pid: parent }
}

/** Whether a pid is still there; access denied still means it exists. */
function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}

/**
 * The restart in flight, or undefined. Stale locks are cleared rather than reported.
 *
 * A lock carries its own `settleUntil`: a helper holds it past the app's boot so that a click a couple
 * of seconds later is told to wait instead of killing an app that is still starting. Once that moment
 * has passed the restart is over by definition — even if the helper that wrote it never got to release
 * it — so the lock stops counting then, and the three-minute bound is only the backstop.
 */
function currentLock() {
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
  } catch {
    return undefined
  }
  const started = Number(lock && lock.started)
  const settleUntil = Number(lock && lock.settleUntil)
  const expired = (Number.isFinite(settleUntil) && Date.now() > settleUntil)
    || !Number.isFinite(started)
    || Date.now() - started > LOCK_TTL_MS
  if (expired) {
    // A helper that was killed mid-restart leaves its lock behind; it must not wedge the button.
    try { fs.rmSync(LOCK_FILE, { force: true }) } catch {}
    return undefined
  }
  return lock
}

/** How long until the restart holding the lock is over, as the lock itself says. */
function lockRetryMs(lock) {
  const settleUntil = Number(lock && lock.settleUntil)
  if (!Number.isFinite(settleUntil)) return undefined
  return Math.max(0, settleUntil - Date.now())
}

/** What the last restart did, as the helper recorded it, or undefined. */
function lastRun() {
  try {
    return JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Leave only once the desktop shell is gone.
 *
 * This host must not be seen stopping on its own: the shell treats *any* host exit as a crash —
 * a clean `process.exit(0)` included — and puts 「应用无法启动或已意外停止」 with the whole stderr
 * tail on screen over a host that is already gone, once per restart. So the helper closes the
 * shell first, this host notices the pid disappear and only then exits. Nothing about the exit
 * itself changes: it is still Node's own `process.exit(0)`.
 */
function exitBehindShell(shellPid) {
  const deadline = Date.now() + SHELL_EXIT_TIMEOUT_MS
  const timer = setInterval(() => {
    if (processAlive(shellPid) && Date.now() < deadline) return
    clearInterval(timer)
    process.exit(0)
  }, SHELL_EXIT_POLL_MS)
  return timer
}

/** What the browser needs to decide whether the button can do anything, and why not if it cannot. */
function restartCapability() {
  if (process.platform !== 'win32') return { available: false, detail: 'unsupported-platform' }
  const exe = process.execPath
  const named = typeof exe === 'string' && exe !== '' && /DeepSeek Harness|dsh-desktop|Electron/i.test(path.basename(exe))
  // The app is launched directly, so it has to be an executable image that is still there: a shell
  // whose executable was moved, uninstalled, or replaced by a script can be closed but not replaced.
  if (named && !(/\.exe$/i.test(exe) && fs.existsSync(exe))) return { available: false, detail: 'app-unusable' }
  if (desktopShell() === undefined) return { available: false, detail: 'no-desktop-shell' }
  return { available: true, mode: 'relaunch-shell' }
}

function safeGet(ctx, key) {
  try {
    return ctx.get ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

/**
 * Refuse anything that is not this window's own same-origin request.
 * The same fence the shipped plugins use: cross-site markers, a foreign Origin, then the Host's
 * connection guard, with loopback as the fallback when it is absent.
 */
function rejectionStatus(ctx, req) {
  const connection = safeGet(ctx, 'connection')
  const fence = connection && typeof connection.requestRejection === 'function' ? connection : undefined
  let hostname = ''
  let authority = ''
  try {
    const url = new URL(`http://${String((req.headers && req.headers.host) || '')}`)
    hostname = url.hostname
    authority = url.host
  } catch {
    return 403
  }
  const headers = req.headers || {}
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== authority) return 403
    } catch {
      return 403
    }
  }
  if (!fence) {
    const local = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
      || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    return local ? null : 403
  }
  try {
    const code = fence.requestRejection(req)
    if (code === undefined || code === null || code === false) return null
    return typeof code === 'number' ? code : 403
  } catch {
    return 403
  }
}

/**
 * The address this host is reachable at, taken from the request the browser just made and
 * accepted only when it is loopback — the same test the fence above applies, so a spoofed Host
 * header cannot point the restart helper at some other machine. The helper uses it to tell when
 * the restarted app is serving again; without it the helper waits out a conservative boot.
 */
function loopbackWebUrl(req) {
  const authority = String((req.headers && req.headers.host) || '')
  try {
    const url = new URL(`http://${authority}`)
    const hostname = url.hostname
    const local = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
      || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    return local ? `http://${url.host}` : ''
  } catch {
    return ''
  }
}

/**
 * Read a small JSON body. Anything unreadable, oversized or not an object becomes an empty object, which
 * the settings normaliser treats as "change nothing".
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > 32 * 1024) return {}
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const route = url.pathname
  const method = req.method || 'GET'

  if (route === `${ROUTE_PREFIX}/state` && (method === 'GET' || method === 'HEAD')) {
    const lock = currentLock()
    sendJson(res, 200, {
      restart: restartCapability(),
      plugin: { version: PLUGIN_VERSION },
      busy: lock !== undefined,
      stage: lock === undefined ? null : (lock.stage ?? null),
      settings: readSettings(SETTINGS_FILE),
      last: lastRun() ?? null,
    })
    return
  }

  if (route === `${ROUTE_PREFIX}/settings`) {
    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, readSettings(SETTINGS_FILE))
      return
    }
    if (method === 'POST') {
      // The client sends only what changed; everything else keeps its value, and every value is validated
      // here rather than trusted. The answer is the complete settings now in force.
      sendJson(res, 200, writeSettings(SETTINGS_FILE, await readJsonBody(req)))
      return
    }
  }

  if (route === `${ROUTE_PREFIX}/restart` && method === 'POST') {
    // One restart at a time: two helpers would each close the shell and launch an app, and the
    // loser of the single-instance race would leave a second, windowless instance behind. A restart
    // that is merely holding the lock while the app settles says so, with the time left to wait —
    // the alternative is a second restart that kills an app in the middle of its boot.
    const lock = currentLock()
    if (lock !== undefined) {
      const settling = lock.stage === 'settling'
      sendJson(res, 200, {
        ok: false,
        code: settling ? 'settling' : 'busy',
        retryInMs: lockRetryMs(lock),
      })
      return
    }
    const settings = readSettings(SETTINGS_FILE)
    const shell = desktopShell()
    if (shell === undefined) {
      sendJson(res, 200, { ok: false, code: 'unavailable', detail: restartCapability().detail })
      return
    }
    try {
      const helper = fileURLToPath(new URL('./relaunch.mjs', import.meta.url))
      // The helper is told both pids — the desktop shell it has to close, and this host, which it
      // must not leave orphaned on the web port — plus the address the restarted app will answer
      // on and where to hold its lock, so it can clean up after itself. Named arguments, because
      // an optional positional one is a trap: leaving the URL out once made the lock path parse
      // as the URL.
      // The guardian goes first and outlives everything here: if the helper dies before the app is
      // back — killed, a suspended machine, a security tool — the guardian is what starts the app
      // instead. It is started before the lock is written so the lock can name it.
      const web = loopbackWebUrl(req)
      let guardianPid = 0
      try {
        const guardian = spawn(
          scriptRuntime(),
          [
            fileURLToPath(new URL('./guardian.mjs', import.meta.url)),
            shell.exe,
            `--web=${web}`,
            `--lock=${LOCK_FILE}`,
            `--log=${GUARDIAN_LOG}`,
            `--app-log=${APP_LOG}`,
            `--shell=${shell.pid}`,
            `--host=${process.pid}`,
          ],
          {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env },
          },
        )
        guardian.unref()
        guardianPid = Number.isFinite(guardian.pid) ? guardian.pid : 0
      } catch (error) {
        console.error(`dsh-plugin-restart: guardian failed to start: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({
          at: new Date().toISOString(),
          started: Date.now(),
          helper: null,
          guardian: guardianPid,
          shellPid: shell.pid,
          hostPid: process.pid,
          stage: 'spawning-helper',
        }))
      } catch {}
      const child = spawn(
        scriptRuntime(),
        [
          helper,
          shell.exe,
          String(shell.pid),
          RELAUNCH_LOG,
          `--host=${process.pid}`,
          `--web=${web}`,
          `--lock=${LOCK_FILE}`,
          `--guardian=${guardianPid}`,
          `--quit=${settings.quit}`,
          `--window=${settings.window}`,
          `--settle=${settings.settleMs}`,
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env },
        },
      )
      child.unref()
      // Answer first: the browser keeps its window and shows "restarting" while the helper closes
      // the shell and starts the app again. The window is deliberately left open — the desktop
      // shell answers a window close by hiding the app in the tray, which reads as "it went to the
      // tray" rather than "it is restarting".
      sendJson(res, 200, { ok: true, mode: 'relaunch' })
      exitBehindShell(shell.pid)
    } catch (error) {
      try { fs.rmSync(LOCK_FILE, { force: true }) } catch {}
      sendJson(res, 200, {
        ok: false,
        code: 'failed',
        detail: String(error instanceof Error ? error.message : error).slice(0, 200),
      })
    }
    return
  }

  res.writeHead(404, { 'cache-control': 'no-store' })
  res.end()
}

/**
 * Mount the routes for the life of the fiber.
 * @param ctx - host services named in {@link inject}.
 */
export function apply(ctx) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const capability = restartCapability()
  console.error(`dsh-plugin-restart: v${PLUGIN_VERSION} log=${RELAUNCH_LOG} shell=${capability.available ? 'desktop' : capability.detail}`)

  ctx.effect(() => {
    const offRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        const rejected = rejectionStatus(ctx, req)
        if (rejected !== null) {
          try {
            res.writeHead(rejected)
            res.end()
          } catch {}
          return
        }
        return handle(req, res).catch((error) => {
          try {
            sendJson(res, 500, { ok: false, code: 'failed', detail: String(error instanceof Error ? error.message : error) })
          } catch {}
        })
      },
    })
    return () => {
      offRoute()
    }
  })
}
