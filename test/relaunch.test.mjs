/**
 * Relaunch-helper harness for dsh-plugin-restart.
 *
 * Runs the real `lib/relaunch.mjs` the way the Host runs it — detached, under Node, from a
 * process whose environment carries `ELECTRON_RUN_AS_NODE=1` (that is what the desktop shell sets
 * for the Host; passing it on to the app starts the app as plain Node: no window, instant exit,
 * "the app closed and never came back"). Stand-ins replace everything else it touches: the Node
 * executable running a probe instead of the app, disposable processes instead of the desktop shell
 * and the host, and a stub HTTP server instead of the app's web port.
 *
 * Six scenarios, each one a way the real restart can go wrong:
 *   1. the host exits by itself  — the ordinary case
 *   2. the host overstays        — it is closed after the app is already starting
 *   3. no web address was passed — the fixed schedule instead of waiting for an answer
 *   4. the executable is missing — nothing may be closed that cannot be replaced
 *   5. the app path is a script  — refused for the same reason, before anything is closed
 *   6. the first launch loses the single-instance race and exits — it is retried
 *
 * Windows only: the whole design is about `taskkill` and the Windows single-instance behaviour.
 * Elsewhere this exits successfully having tested nothing rather than pretending otherwise.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const logPath = join(root, 'relaunch.log')
const lockPath = join(root, 'relaunch.lock')
const appLogPath = join(root, 'app.log')
const lastRunPath = join(root, 'last-run.json')
const marker = join(root, 'marker.txt')
const flag = join(root, 'flag.txt')
const probe = join(root, 'probe.mjs')
const dyingProbe = join(root, 'dying-probe.mjs')
const scriptPath = join(root, 'not-an-executable.cmd')
const missingExe = join(root, 'not-installed.exe')

/**
 * The app stand-in. Windows cannot start a script directly, and the helper launches the app
 * directly on purpose (so it owns the pid and can tell a real launch from a lost lock race) — so
 * the stand-in is the Node executable itself, with the probe handed to it through `NODE_OPTIONS`,
 * which the helper does not strip.
 *
 * The probe has to ignore the helper it is also loaded into (same `NODE_OPTIONS`, different
 * process): the app is the one started with no script, so `argv[1]` is what tells them apart.
 * It records the environment it was handed (that is the leak assertion), says something on stdout
 * so the captured app log has content, and stays alive long enough to look like an app that owns
 * the single-instance lock.
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
  '  setTimeout(() => process.exit(0), 5000)',
  '}',
  '',
].join('\n')
writeFileSync(probe, probeBody(false))
writeFileSync(dyingProbe, probeBody(true))
writeFileSync(scriptPath, '@echo not an executable image\r\n')

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

/**
 * What the Host's environment actually carries: the shell runs the Host as Node, and the Host has
 * no `DSH_WEB_URL` of its own (a process started from a session that has one must not be able to
 * change what this test proves — the address is passed as an argument instead). The poke schedule
 * is shortened here, because a harness must not sit through twelve seconds per scenario watching
 * something it can measure in a few hundred milliseconds.
 */
const POKE_GAPS = [120, 180, 240]

/** The helper's environment, with the stand-in probe wired into whatever it launches. */
function helperEnvFor(appProbe) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_RESTART_POKE_MS: POKE_GAPS.join(','),
    PROBE_MARKER: marker,
    PROBE_FLAG: flag,
  }
  delete env.DSH_WEB_URL
  if (appProbe !== undefined) env.NODE_OPTIONS = `--import ${new URL(`file:///${appProbe.replace(/\\/g, '/')}`).href}`
  return env
}

/** One full restart, and everything it left behind. */
async function restart(name, { appExe = process.execPath, appProbe = probe, hostExits = true, withUrl = true, legacy = false } = {}) {
  for (const file of [marker, logPath, lockPath, appLogPath, lastRunPath, flag]) rmSync(file, { force: true })
  const shell = ping(60)
  const host = ping(hostExits ? 2 : 60)
  await sleep(400)
  assert.equal(alive(shell.pid), true, `${name}: the shell stand-in runs`)
  assert.equal(alive(host.pid), true, `${name}: the host stand-in runs`)

  // The named form is what this version's Host sends; the positional form is what the previous
  // version sent, and the first restart after an update really does run that Host against this
  // helper.
  const args = [HELPER, appExe, String(shell.pid), logPath]
  if (legacy) args.push(String(host.pid), withUrl ? url : '', lockPath)
  else {
    args.push(`--host=${host.pid}`)
    if (withUrl) args.push(`--web=${url}`)
    args.push(`--lock=${lockPath}`)
  }
  const started = Date.now()
  const helper = spawn(process.execPath, args, { stdio: 'ignore', env: helperEnvFor(appProbe) })
  const code = await new Promise((resolve) => helper.once('close', resolve))
  // The last poke is fired just before the helper exits; the probe appends a moment later.
  await sleep(1500)

  const log = read(logPath)
  const summary = readJson(lastRunPath)
  const launches = read(marker).trim().split(/\r?\n/).filter(Boolean)
  const elapsed = Date.now() - started
  // Recorded before the harness tidies up, or "was the shell left alone?" answers itself.
  const shellAlive = alive(shell.pid)
  const hostAlive = alive(host.pid)
  for (const child of [shell, host]) if (alive(child.pid)) child.kill()
  return { name, code, log, summary, launches, elapsed, shellPid: shell.pid, hostPid: host.pid, shellAlive, hostAlive }
}

// --- 1. the ordinary restart --------------------------------------------------

const ordinary = await restart('host exits by itself')
assert.equal(ordinary.code, 0, 'the helper exits cleanly')
assert.equal(ordinary.summary.ok, true, 'the restart succeeded')
assert.equal(ordinary.summary.answered, true, 'the app answered on its web port')
assert.equal(ordinary.summary.attempts, 1, 'the first launch took')
assert.equal(ordinary.summary.pokes, 3, 'the window was raised three times')
assert.deepEqual(ordinary.summary.gaps, POKE_GAPS, 'the schedule came from DSH_RESTART_POKE_MS')
assert.equal(ordinary.summary.appExit, null, 'the app never exited')
assert.ok(ordinary.summary.ms.appStarted > ordinary.summary.ms.shellGone, 'the app starts after the shell is gone')
assert.ok(ordinary.summary.ms.appUp > ordinary.summary.ms.appStarted, 'and it answers after it was started')
assert.ok(ordinary.summary.ms.total < 6000, `the whole restart is quick (${ordinary.summary.ms.total}ms)`)
assert.equal(existsSync(lockPath), false, 'the lock is released when the helper is done')
assert.ok(read(appLogPath).includes('probe-stdout'), "the app's own output was captured")
assert.ok(!/node=1/.test(read(marker)), `ELECTRON_RUN_AS_NODE never reaches the app (${JSON.stringify(ordinary.launches)})`)
assert.match(read(marker), /^run node=$/m, 'and the marker records the app it started, with that variable gone')
assert.ok(!/taskkill.*\/T/.test(ordinary.log), 'no kill uses /T')
// The app is launched before the old host is even looked at, so by then it has usually left on its
// own — which is the point: that wait used to sit on the user's clock.
assert.ok(!/host: closing pid/.test(ordinary.log), 'a host that leaves on its own is not touched')
assert.ok(/host already gone|host exited after \d+ms/.test(ordinary.log), 'and the log accounts for it')
assert.equal(ordinary.launches.length, 1 + ordinary.summary.pokes, 'one launch plus one per poke')
console.log(`1 ordinary restart: launched=${ordinary.summary.ms.appStarted}ms appUp=${ordinary.summary.ms.appUp}ms total=${ordinary.summary.ms.total}ms`)

// --- 2. the host overstays ----------------------------------------------------

const overstay = await restart('host overstays', { hostExits: false })
assert.equal(overstay.summary.ok, true, 'the restart still succeeded')
assert.ok(/after kill host pid=\d+ alive=false/.test(overstay.log), 'a host that overstays is closed')
const launchAt = overstay.log.search(/launch attempt 1/)
const hostAt = overstay.log.search(/host: closing pid/)
assert.ok(launchAt > -1 && hostAt > -1, 'both the launch and the host close are logged')
assert.ok(launchAt < hostAt, 'the app is started before the old host is chased down — that wait was pure latency')
console.log('2 host overstays: the app was started first, then the old host closed')

// --- 3. no web address, and the previous Host's argument form ------------------

const noUrl = await restart('no web address', { withUrl: false })
assert.equal(noUrl.summary.ok, true, 'the restart succeeded without an address to poll')
assert.equal(noUrl.summary.answered, false, 'nothing answered, and that is not a failure here')
assert.equal(noUrl.summary.pokes, 3, 'the window is still raised three times')
assert.ok(/web=\(none\)/.test(noUrl.log), 'and the log says there was no address to poll')
assert.ok(/lock=.*relaunch\.lock/.test(noUrl.log), 'while the lock path still arrived intact')
console.log('3 no web address: waited out a boot and poked three times')

// The previous version of the Host passed these positionally. A URL that is missing must not
// shift the lock path into its place — that is how a restart ends up polling a file name.
const legacy = await restart('positional arguments from an older Host', { legacy: true })
assert.equal(legacy.summary.ok, true, 'the older argument form still restarts')
assert.equal(legacy.summary.answered, true, 'and still finds the app')
assert.ok(!legacy.log.includes(`web=${lockPath}`), 'the lock path is never mistaken for the web address')
console.log('3b positional arguments: parsed as the older Host meant them')

// --- 4. the executable is missing, or is not an executable ---------------------

const missing = await restart('app executable missing', { appExe: missingExe, appProbe: undefined })
assert.equal(missing.code, 1, 'the helper refuses to continue')
assert.equal(missing.shellAlive, true, 'the shell was NOT closed — it cannot be replaced')
assert.ok(/missing or not an executable image/.test(missing.log), 'and the log says why')
assert.equal(missing.summary.ok, false, 'the restart is recorded as failed')
assert.equal(missing.summary.attempts, 0, 'nothing was launched')
assert.equal(existsSync(lockPath), false, 'the lock does not stay behind to wedge the next attempt')
assert.equal(existsSync(marker), false, 'no app was started')

// A `.cmd` cannot be started by `spawn` at all, so it must be refused before the shell is closed —
// otherwise the restart would close the app and then fail to bring it back.
const script = await restart('app path is a script', { appExe: scriptPath, appProbe: undefined })
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
assert.ok(raced.launches.length >= 2, 'two launches happened')
console.log('5 first launch lost the race: retried, and the second attempt took')

console.log('\nhelper log (first launch loses the lock):')
console.log(raced.log.trim().split('\n').map((line) => `  ${line}`).join('\n'))
console.log('')
console.log('RESULT: dsh-plugin-restart relaunch helper closes the shell first, refuses to close what it')
console.log('        cannot restart, launches the app without ELECTRON_RUN_AS_NODE, retries a lost lock')
console.log('        race, captures the app output, raises the window, and never uses /T')

server.close()
rmSync(root, { recursive: true, force: true })
process.exit(0)
