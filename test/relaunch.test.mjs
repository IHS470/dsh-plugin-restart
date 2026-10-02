/**
 * Relaunch-helper harness for dsh-plugin-restart.
 *
 * Runs the real `lib/relaunch.mjs` the way the Host runs it — detached, under Node, from a process
 * whose environment carries `ELECTRON_RUN_AS_NODE=1` (that is what the desktop shell sets for the
 * Host; passing it on to the app starts the app as plain Node: no window, instant exit, "the app
 * closed and never came back"). Stand-ins replace everything else it touches: a copy of the Node
 * executable that runs a probe instead of the app, disposable processes instead of the desktop shell
 * and the host, and a stub HTTP server instead of the app's web port.
 *
 * The stand-in is a *copy* with its own image name on purpose: the helper now accounts for every
 * process running the app's image before it launches, so the stand-in has to be distinguishable from
 * this harness and from the helper itself — which is exactly the property the real app has.
 *
 * Seven scenarios, each one a way the real restart can go wrong:
 *   1. the host exits by itself        — the ordinary case
 *   2. the host overstays              — it is closed before the app starts, freeing the port
 *   3. no web address was passed       — the fixed delay instead of waiting for an answer
 *   4. an older Host's argument form   — positional, as the previous version sent them
 *   5. the executable is missing, or is not an executable — nothing may be closed that cannot be replaced
 *   6. the first launch loses the single-instance race     — it is retried
 *   7. a straggler of the previous generation survives the shell — it is closed before the launch
 *
 * Windows only: the whole design is about `taskkill`, `tasklist` and the Windows single-instance
 * behaviour. Elsewhere this exits successfully having tested nothing rather than pretending otherwise.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log(`SKIP: the relaunch helper is Windows-only (platform: ${process.platform})`)
  process.exit(0)
}

const HELPER = fileURLToPath(new URL('../lib/relaunch.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'dsh-restart-relaunch-'))
// Its own image name, not shared with the guardian harness: both harnesses leave stand-in processes
// behind for a moment, and a shared name would make one harness's leftovers look like the other
// harness's stragglers.
const appExe = join(root, 'dsh-relaunch-standin.exe')
const probe = join(root, 'probe.mjs')
const dyingProbe = join(root, 'dying-probe.mjs')
const scriptPath = join(root, 'not-an-executable.cmd')
const missingExe = join(root, 'not-installed.exe')

/** The app stand-in: the Node executable under its own name, so its image is its own. */
copyFileSync(process.execPath, appExe)
writeFileSync(scriptPath, '@echo not an executable image\r\n')

/**
 * The probe is handed to the stand-in through `NODE_OPTIONS`, which the helper does not strip. It has
 * to ignore the helper it is also loaded into (same `NODE_OPTIONS`, different process): the app is the
 * one started with no script, so `argv[1]` is what tells them apart. It records the environment it was
 * handed (that is the leak assertion), says something on stdout so the captured app log has content,
 * and stays alive long enough to look like an app that owns the single-instance lock.
 *
 * `PROBE_LIFE_MS` is how long that is: just past the helper's own lock-settle check for the app and
 * the pokes (so they look alive and then leave on their own, and one scenario's leftovers cannot be
 * mistaken for the next one's straggler), and much longer for the straggler scenario, which must still
 * be there when the helper looks for it.
 */
const probeBody = (exitFirst) => [
  "import fs from 'node:fs'",
  'if (process.argv[1] === undefined) {',
  `  fs.appendFileSync(process.env.PROBE_MARKER, \`run node=\${process.env.ELECTRON_RUN_AS_NODE ?? ''}\\n\`)`,
  "  console.log('probe-stdout')",
  ...(exitFirst
    ? [
        '  if (!fs.existsSync(process.env.PROBE_FLAG)) {',
        "    fs.writeFileSync(process.env.PROBE_FLAG, 'x')",
        '    process.exit(3)',
        '  }',
      ]
    : []),
  '  setTimeout(() => process.exit(0), Number(process.env.PROBE_LIFE_MS) || 2000)',
  '}',
  '',
].join('\n')
writeFileSync(probe, probeBody(false))
writeFileSync(dyingProbe, probeBody(true))

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}
const ping = (seconds) => spawn('cmd.exe', ['/c', `ping -n ${seconds} 127.0.0.1 >nul`], { stdio: 'ignore', windowsHide: true })
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined)

// A stub web port: any answer counts as "the app is up", exactly like the real 401.
const server = http.createServer((_request, response) => {
  response.statusCode = 401
  response.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
console.log('stub web port:', url)

const POKE_DELAY_MS = 200
/** The real settle is six seconds of holding the lock while the app boots; here it only has to happen. */
const SETTLE_MS = 700

/** The helper's environment, with the stand-in probe wired into whatever it launches. */
function helperEnvFor(appProbe, marker, flag, extra = {}) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_RESTART_POKE_MS: String(POKE_DELAY_MS),
    DSH_RESTART_SETTLE_MS: String(SETTLE_MS),
    PROBE_MARKER: marker,
    PROBE_FLAG: flag,
    ...extra,
  }
  delete env.DSH_WEB_URL
  if (appProbe !== undefined) env.NODE_OPTIONS = `--import ${new URL(`file:///${appProbe.replace(/\\/g, '/')}`).href}`
  return env
}

/**
 * One full restart, and everything it left behind.
 *
 * Every scenario writes into a directory of its own: the app stand-in keeps `app.log` open for a few
 * seconds, so scenarios sharing one directory raced each other's cleanup — and could read each other's
 * marker while a probe was still alive. That is how this harness failed on a Windows runner once.
 */
async function restart(name, { exe = appExe, appProbe = probe, hostExits = true, withUrl = true, legacy = false, stray = false } = {}) {
  const dir = join(root, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'relaunch.log')
  const lockPath = join(dir, 'relaunch.lock')
  const appLogPath = join(dir, 'app.log')
  const lastRunPath = join(dir, 'last-run.json')
  const marker = join(dir, 'marker.txt')
  const flag = join(dir, 'flag.txt')

  const shell = ping(60)
  const host = ping(hostExits ? 2 : 60)
  // A straggler of the previous generation: the app's own image, started before the restart and left
  // running past the helper's wait, which is what a killed Electron shell can leave behind.
  const oldGeneration = stray
    ? spawn(exe, [], { stdio: 'ignore', windowsHide: true, env: helperEnvFor(appProbe, marker, flag, { PROBE_LIFE_MS: '30000' }) })
    : undefined
  await sleep(400)
  assert.equal(alive(shell.pid), true, `${name}: the shell stand-in runs`)
  assert.equal(alive(host.pid), true, `${name}: the host stand-in runs`)

  const args = [HELPER, exe, String(shell.pid), logPath]
  if (legacy) args.push(String(host.pid), withUrl ? url : '', lockPath)
  else {
    args.push(`--host=${host.pid}`, `--guardian=${process.pid}`)
    if (withUrl) args.push(`--web=${url}`)
    args.push(`--lock=${lockPath}`)
  }
  const started = Date.now()
  const helper = spawn(process.execPath, args, { stdio: 'ignore', env: helperEnvFor(appProbe, marker, flag) })
  // Sampled while the helper is still running: the lock has to say, from the inside, that the restart
  // is over except for the app settling — that is what keeps a second click from killing a booting app.
  let lockDuring
  let launchedAt
  while (helper.exitCode === null && Date.now() - started < 30000) {
    if (launchedAt === undefined && read(marker).trim() !== '') launchedAt = Date.now() - started
    const during = readJson(lockPath)
    if (during !== undefined) lockDuring = during
    await sleep(50)
  }
  const code = helper.exitCode ?? await new Promise((resolve) => helper.once('close', resolve))
  // The last poke is fired just before the helper exits; the probe appends a moment later.
  await sleep(1500)

  const log = read(logPath)
  const summary = readJson(lastRunPath)
  const launches = read(marker).trim().split(/\r?\n/).filter(Boolean)
  const elapsed = Date.now() - started
  // Recorded before the harness tidies up, or "was the shell left alone?" answers itself.
  const shellAlive = alive(shell.pid)
  const hostAlive = alive(host.pid)
  const stragglerAlive = oldGeneration === undefined ? undefined : alive(oldGeneration.pid)
  for (const child of [shell, host, oldGeneration]) if (child !== undefined && alive(child.pid)) child.kill()
  return {
    name, code, log, summary, launches, elapsed, lockDuring, launchedAt,
    shellPid: shell.pid, hostPid: host.pid, shellAlive, hostAlive, stragglerAlive,
    lockPath, appLogPath, marker, appLog: read(appLogPath),
  }
}

// --- 1. the ordinary restart --------------------------------------------------

const ordinary = await restart('host exits by itself')
assert.equal(ordinary.code, 0, 'the helper exits cleanly')
assert.equal(ordinary.summary.ok, true, 'the restart succeeded')
assert.equal(ordinary.summary.answered, true, 'the app answered on its web port')
assert.equal(ordinary.summary.attempts, 1, 'the first launch took')
assert.equal(ordinary.summary.pokes, 1, 'the window was raised exactly once')
assert.equal(ordinary.summary.straysClosed, 0, 'there was nothing of a previous generation to close')
assert.equal(ordinary.summary.appExit, null, 'the app never exited')
assert.ok(ordinary.summary.ms.shellGone < ordinary.summary.ms.appStarted, 'the app starts after the shell is gone')
assert.ok(ordinary.summary.ms.appUp > ordinary.summary.ms.appStarted, 'and it answers after it was started')
assert.ok(ordinary.summary.ms.total < 8000, `the whole restart is quick (${ordinary.summary.ms.total}ms)`)
assert.equal(existsSync(ordinary.lockPath), false, 'the lock is released when the helper is done')
assert.ok(ordinary.appLog.includes('probe-stdout'), "the app's own output was captured")
assert.ok(!/node=1/.test(read(ordinary.marker)), `ELECTRON_RUN_AS_NODE never reaches the app (${JSON.stringify(ordinary.launches)})`)
assert.match(read(ordinary.marker), /^run node=$/m, 'and the marker records the app it started, with that variable gone')
assert.ok(!/taskkill.*\/T/.test(ordinary.log), 'no kill uses /T')
// The app is launched before the old host is even looked at, so by then it has usually left on its
// own — which is the point: that wait used to sit on the user's clock. A host that is somehow still
// there is closed, which is why either line is acceptable here.
assert.ok(/host already gone|after kill host pid=\d+ alive=false/.test(ordinary.log), 'the old host is accounted for')
assert.equal(ordinary.launches.length, 1 + ordinary.summary.pokes, 'one launch plus one per poke')
// 0.2.0 spent a process enumeration on the critical path; the shell is now closed with `process.kill`
// (no `taskkill.exe` to start) and the scan overlaps that close instead of following it.
assert.ok(ordinary.summary.ms.shellGone < 500, `the shell is closed quickly, without starting taskkill.exe (${ordinary.summary.ms.shellGone}ms)`)
assert.ok(ordinary.launchedAt !== undefined && ordinary.launchedAt < 2500, `and the app is launched promptly (${ordinary.launchedAt}ms from spawn, including the stand-in's own boot)`)
assert.equal(ordinary.lockDuring?.stage, 'settling', 'the lock reports that the restart is only settling')
assert.ok(Number(ordinary.lockDuring?.settleUntil) > Date.now() - ordinary.elapsed, 'and carries the moment it stops counting')
assert.ok(ordinary.lockDuring?.appPid > 0, 'naming the app it started, so the guardian leaves it alone')
assert.ok(ordinary.log.search(/answering=true/) < ordinary.log.search(/poked the app/), 'the window is raised only after the app answers')
assert.ok(ordinary.log.search(/poked the app/) < ordinary.log.search(/holding the lock/), 'and the lock is held past the raise')
console.log(`1 ordinary restart: launched=${ordinary.summary.ms.appStarted}ms appUp=${ordinary.summary.ms.appUp}ms settled=${ordinary.summary.ms.settled ?? '-'}ms total=${ordinary.summary.ms.total}ms`)

// --- 2. the host overstays ----------------------------------------------------

const overstay = await restart('host overstays', { hostExits: false })
assert.equal(overstay.summary.ok, true, 'the restart still succeeded')
assert.ok(/after kill host pid=\d+ alive=false/.test(overstay.log), 'a host that overstays is closed')
const launchAt = overstay.log.search(/launch attempt 1/)
const hostAt = overstay.log.search(/host: closing pid/)
assert.ok(launchAt > -1 && hostAt > -1, 'both the launch and the host close are logged')
assert.ok(launchAt < hostAt, 'the old host is chased down after the app is already starting — that is where the latency went')
console.log('2 host overstays: the old host was closed, then the app was started')

// --- 3. no web address, and the previous Host's argument form ------------------

const noUrl = await restart('no web address', { withUrl: false })
assert.equal(noUrl.summary.ok, true, 'the restart succeeded without an address to poll')
assert.equal(noUrl.summary.answered, false, 'nothing answered, and that is not a failure here')
assert.equal(noUrl.summary.pokes, 1, 'the window is still raised once')
assert.ok(/web=\(none\)/.test(noUrl.log), 'and the log says there was no address to poll')
assert.ok(/lock=.*relaunch\.lock/.test(noUrl.log), 'while the lock path still arrived intact')
console.log('3 no web address: waited out a boot and raised the window once')

// The previous version of the Host passed these positionally. A URL that is missing must not shift the
// lock path into its place — that is how a restart ends up polling a file name.
const legacy = await restart('positional arguments from an older Host', { legacy: true })
assert.equal(legacy.summary.ok, true, 'the older argument form still restarts')
assert.equal(legacy.summary.answered, true, 'and still finds the app')
assert.ok(!legacy.log.includes(`web=${legacy.lockPath}`), 'the lock path is never mistaken for the web address')
console.log('3b positional arguments: parsed as the older Host meant them')

// --- 4. the executable is missing, or is not an executable ---------------------

const missing = await restart('app executable missing', { exe: missingExe, appProbe: undefined })
assert.equal(missing.code, 1, 'the helper refuses to continue')
assert.equal(missing.shellAlive, true, 'the shell was NOT closed — it cannot be replaced')
assert.ok(/missing or not an executable image/.test(missing.log), 'and the log says why')
assert.equal(missing.summary.ok, false, 'the restart is recorded as failed')
assert.equal(missing.summary.attempts, 0, 'nothing was launched')
assert.equal(existsSync(missing.lockPath), false, 'the lock does not stay behind to wedge the next attempt')
assert.equal(existsSync(missing.marker), false, 'no app was started')

// A `.cmd` cannot be started by `spawn` at all, so it must be refused before the shell is closed —
// otherwise the restart would close the app and then fail to bring it back.
const script = await restart('app path is a script', { exe: scriptPath, appProbe: undefined })
assert.equal(script.code, 1, 'a script is refused too')
assert.equal(script.shellAlive, true, 'and the shell is still running')
assert.equal(script.summary.attempts, 0, 'with nothing launched')
console.log('4 app executable missing or a script: the shell was left running, nothing launched')

// --- 5. the first launch loses the single-instance race -----------------------

const raced = await restart('first launch loses the lock', { appProbe: dyingProbe })
assert.equal(raced.summary.ok, true, 'the retry succeeded')
assert.equal(raced.summary.attempts, 2, 'the losing launch was retried once')
assert.equal(raced.summary.appExit, 3, 'the exit code of the losing launch is recorded')
assert.ok(/exited immediately \(code 3\)/.test(raced.log), 'and it was logged as a lock race')
console.log('5 first launch lost the race: retried, and the second attempt took')

// --- 6. a straggler of the previous generation --------------------------------

const straggler = await restart('a straggler survives the shell', { stray: true })
assert.equal(straggler.summary.ok, true, 'the restart still succeeded')
assert.ok(straggler.summary.straysClosed >= 1, `the straggler was closed (${straggler.summary.straysClosed})`)
assert.ok(/stray app process: closing pid/.test(straggler.log), 'and it is named in the log')
assert.equal(straggler.stragglerAlive, false, 'the straggler is gone by the time the harness looks')
const strayAt = straggler.log.search(/stray app process: closing pid/)
assert.ok(strayAt > 0 && straggler.log.search(/launch attempt 1/) > strayAt, 'the app starts only once the profile is free')
console.log(`6 straggler: closed before the launch (straysClosed=${straggler.summary.straysClosed})`)
console.log('\nhelper log (a straggler survives the shell):')
console.log(straggler.log.trim().split('\n').map((line) => `  ${line}`).join('\n'))
console.log('')
console.log('RESULT: dsh-plugin-restart relaunch helper closes the shell first, refuses to close what it')
console.log('        cannot restart, clears the previous generation, launches the app without')
console.log('        ELECTRON_RUN_AS_NODE, retries a lost lock race, captures the app output, raises the')
console.log('        window once, and never uses /T')

server.close()
try { rmSync(root, { recursive: true, force: true }) } catch {}
process.exit(0)
