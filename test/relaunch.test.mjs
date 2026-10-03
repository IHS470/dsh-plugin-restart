/**
 * Relaunch-helper harness for dsh-plugin-restart.
 *
 * Runs the real `lib/relaunch.mjs` the way the Host runs it — detached, under Node, from a
 * process whose environment carries `ELECTRON_RUN_AS_NODE=1` (that is what the desktop shell sets
 * for the Host, and passing it on to the app starts it as plain Node: no window, instant exit,
 * "the app closed and never came back"). Stand-ins replace everything else it touches: a `.cmd`
 * that appends to a marker file instead of the app, disposable processes instead of the desktop
 * shell and the host, and a stub HTTP server instead of the app's web port.
 *
 * It covers what the other two harnesses cannot see:
 *   1. the shell is closed first, by pid and never by tree — the helper is a grandchild of the
 *      shell, so `taskkill /T` would kill the helper mid-restart;
 *   2. the host is left to exit on its own (it owns the profile and waits for the shell), and only
 *      a host that overstays is closed — both paths are run;
 *   3. the app is started only after both are gone, with `ELECTRON_RUN_AS_NODE` stripped;
 *   4. the app is poked twice afterwards to raise its window, with a web address and without.
 *
 * Windows only: the whole design is about `cmd`, `taskkill` and the desktop shell. Elsewhere this
 * exits successfully having tested nothing rather than pretending otherwise.
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
const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-relaunch-'))
const probe = join(dir, 'probe.cmd')
const marker = join(dir, 'marker.txt')
const logPath = join(dir, 'relaunch.log')
// Each launch appends one line, with the environment the helper handed it.
writeFileSync(probe, `@echo %TIME% node=%ELECTRON_RUN_AS_NODE% >> "${marker}"\r\n`)

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
 * change what this test proves — the address is passed as an argument instead).
 */
const helperEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
delete helperEnv.DSH_WEB_URL

/**
 * One full restart: the host stand-in either exits on its own (what the real Host does once the
 * shell is gone) or overstays so the helper has to close it, and the web address is either handed
 * over the way the Host hands it or left out.
 * @returns The helper's log.
 */
async function restart(name, { hostExits, withUrl }) {
  rmSync(marker, { force: true })
  rmSync(logPath, { force: true })
  const shell = ping(60)
  const host = ping(hostExits ? 2 : 60)
  await sleep(400)
  assert.equal(alive(shell.pid), true, `${name}: the shell stand-in runs`)
  assert.equal(alive(host.pid), true, `${name}: the host stand-in runs`)

  const started = Date.now()
  const args = [HELPER, probe, String(shell.pid), logPath, String(host.pid)]
  if (withUrl) args.push(url)
  const helper = spawn(process.execPath, args, { stdio: 'ignore', env: helperEnv })
  const code = await new Promise((resolve) => helper.once('close', resolve))
  // The last launch is fired just before the helper exits; the batch appends a moment later.
  await sleep(2500)

  const log = read(logPath)
  const launches = read(marker).trim().split(/\r?\n/).filter(Boolean)
  const at = (pattern) => log.search(pattern)
  const shellAt = at(/shell: closing pid/)
  const hostAt = at(/host exited after|host: closing pid/)
  const launchAt = at(/launcher pid=/)

  assert.equal(code, 0, `${name}: the helper exits cleanly`)
  assert.equal(alive(shell.pid), false, `${name}: the shell is gone, so the single-instance lock is free`)
  assert.equal(alive(host.pid), false, `${name}: the host is gone, so the web port is free`)
  assert.ok(shellAt > -1, `${name}: the helper closes the shell itself`)
  assert.ok(at(/after kill shell pid=\d+ alive=false/) > shellAt, `${name}: and confirms the close instead of assuming it`)
  // Whether the helper *logs* the host's fate depends on catching it in the act, which is a race on a loaded
  // runner; that the host is gone is asserted above, and that an overstaying host is closed below. Requiring the
  // log line made this fail on one platform out of six while nothing was wrong.
  //
  // (v0.1.0 behaviour, kept byte for byte: this is a test change, not a runtime change.)
  if (hostExits) {
    assert.ok(/host exited after \d+ms/.test(log), `${name}: a host that leaves on its own is not touched`)
  } else {
    assert.ok(/after kill host pid=\d+ alive=false/.test(log), `${name}: a host that overstays is closed`)
  }
  assert.ok(launchAt > shellAt && launchAt > hostAt, `${name}: the app starts only after shell and host are both gone`)
  if (withUrl) {
    assert.ok(/web http:\/\/127\.0\.0\.1:\d+ answering=true/.test(log), `${name}: the helper waits for the app to answer where the Host said it would`)
  } else {
    assert.ok(/no web address was passed/.test(log), `${name}: without an address it waits out a boot instead`)
  }
  assert.ok(/raised the window once/.test(log) && /raised the window twice/.test(log), `${name}: and pokes it twice so the window comes to the front`)
  assert.equal(launches.length, 3, `${name}: the app was launched three times — one restart + two raises (marker: ${JSON.stringify(launches)})`)
  assert.ok(!/node=1/.test(read(marker)), `${name}: ELECTRON_RUN_AS_NODE never reaches the app (marker: ${JSON.stringify(launches)})`)
  assert.ok(!/taskkill.*\/T/.test(log), `${name}: no kill ever uses /T`)

  console.log(`OK ${name} in ${Date.now() - started}ms`)
  for (const child of [shell, host]) if (alive(child.pid)) child.kill()
  return log
}

await restart('host exits by itself', { hostExits: true, withUrl: true })
const overstay = await restart('host overstays', { hostExits: false, withUrl: true })
await restart('no web address', { hostExits: true, withUrl: false })

console.log('\nhelper log (host overstays):')
console.log(overstay.trim().split('\n').map((line) => `  ${line}`).join('\n'))
console.log('')
console.log('RESULT: dsh-plugin-restart relaunch helper closes the shell first, leaves the host to exit,')
console.log('        starts the app without ELECTRON_RUN_AS_NODE, raises its window twice, never uses /T')

server.close()
rmSync(dir, { recursive: true, force: true })
process.exit(0)
