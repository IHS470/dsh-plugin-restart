/**
 * Process and launch plumbing shared by the restart helper and its guardian.
 *
 * Both are detached scripts that outlive the app they are restarting, so everything here is
 * deliberately blunt: spawn the executable, count what is running, close one pid at a time.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

/** Whether a pid is still there; access denied still means it exists. */
export function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}

/**
 * The environment the app must be started with — the Host's, minus `ELECTRON_RUN_AS_NODE`.
 *
 * That variable is how the desktop shell runs the dsh host as plain Node, so anything the host
 * spawns inherits it. Passed on to the app it starts the Electron binary as a script-less Node
 * process: no window, instant exit, and the user sees exactly "the app closed and never came back".
 */
export function launchEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/**
 * Whether the app can actually be started.
 *
 * It is launched directly — no `cmd` in between, so a launched instance owns its pid and can be
 * told apart from one that lost the single-instance race. That also means it must be an executable
 * image: `spawn` refuses a `.cmd`/`.bat` with EINVAL, and closing the shell first would then leave
 * the user with no app at all.
 */
export function launchable(exe) {
  return typeof exe === 'string' && /\.exe$/i.test(exe) && fs.existsSync(exe)
}

/** Open the app's own output log, rewritten on every launch: one boot per file. */
export function openAppLog(appLogPath) {
  try {
    return fs.openSync(appLogPath, 'w')
  } catch {
    return undefined
  }
}

/** Start the app directly, detached, with its output captured. */
export function launchApp(exe, appLogPath) {
  const fd = appLogPath === undefined ? undefined : openAppLog(appLogPath)
  try {
    const child = spawn(exe, [], {
      detached: true,
      stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd],
      env: launchEnv(),
      windowsHide: true,
    })
    child.unref()
    return child
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

/**
 * Every running process with this image name, as pids, never including this one.
 *
 * `tasklist` rather than a native call: it is on every Windows install, it needs no privileges, and
 * the only thing asked of it is a list of numbers. Any failure is reported as "none running",
 * because a restart must not be blocked by a diagnostic that did not work.
 */
export function appProcesses(imageName) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    } catch {
      resolve([])
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.once('error', () => resolve([]))
    child.once('close', () => {
      const pids = []
      for (const line of out.split(/\r?\n/)) {
        const match = /^"[^"]+","(\d+)"/.exec(line.trim())
        if (match !== null) pids.push(Number(match[1]))
      }
      resolve(pids.filter((pid) => pid !== process.pid))
    })
  })
}

/**
 * The pids of `imageName` processes that already existed before `beforeMs`.
 *
 * This exists because matching a previous generation by *pid* is not safe, and the failure mode is
 * spectacular: the pids of a just-dead generation are recycled immediately, and the first process to
 * receive one of them is the app this helper is starting. A snapshot taken before the launch therefore
 * contains the new app's own pid, and "anything from the snapshot that is still alive cannot be the new
 * app" is simply false. That is how 0.4.0 closed its own window: the helper killed the app it had just
 * started, six seconds in, after that app had already begun serving.
 *
 * Creation time cannot be recycled, so it is what this asks about. It costs about a second (CIM), which
 * is why it is only ever used *after* the app has been launched — never in front of it.
 *
 * Anything whose creation time cannot be read (a protected process) is left out rather than guessed at:
 * not closing something is always better than closing the wrong thing.
 *
 * @returns Pids, never including this process.
 */
export function appProcessesBefore(imageName, beforeMs) {
  return new Promise((resolve) => {
    const script = `Get-CimInstance Win32_Process -Filter "Name='${imageName.replace(/'/g, "''")}'" | ForEach-Object { $c = $_.CreationDate; if ($c) { '{0}:{1}' -f $_.ProcessId, ([DateTimeOffset]$c).ToUnixTimeMilliseconds() } }`
    let out = ''
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    } catch {
      resolve([])
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.once('error', () => resolve([]))
    child.once('close', () => {
      const pids = []
      for (const line of out.split(/\r?\n/)) {
        const [pidText, bornText] = line.trim().split(':')
        const pid = Number(pidText)
        const born = Number(bornText)
        if (!Number.isFinite(pid) || !Number.isFinite(born)) continue
        if (pid === process.pid) continue
        if (born < beforeMs) pids.push(pid)
      }
      resolve(pids)
    })
  })
}

/**
 * One process, by pid — never the tree: the helper is a grandchild of the shell
 * (shell → host → helper), so `taskkill /T` would kill it mid-restart.
 *
 * `process.kill` terminates the process directly instead of starting `taskkill.exe` first, which is
 * worth about a tenth of a second on the one path the user is actually waiting on. `taskkill` stays
 * as the fallback for a process this one is not allowed to terminate.
 */
export function closePid(pid, why, log = () => {}) {
  if (!alive(pid)) return false
  log(`${why}: closing pid ${pid}`)
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch (error) {
    const code = error instanceof Error ? error.code : undefined
    if (code === 'ESRCH') return false
    log(`process.kill ${pid} failed (${code ?? 'unknown'}); falling back to taskkill`)
  }
  try {
    spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch (error) {
    log(`taskkill ${pid} failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
