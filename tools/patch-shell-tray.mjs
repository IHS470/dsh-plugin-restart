#!/usr/bin/env node
/**
 * dsh-desktop-tray-restart — add a Restart item to the DeepSeek Harness tray menu.
 *
 * The desktop shell's tray menu has only "Open DeepSeek Harness" and "Quit DeepSeek Harness". The tray lives in
 * the shell's main process (`new Tray`, `setContextMenu`), and a plugin cannot reach it: the host is plain Node
 * without Electron APIs, and the page only gets the fixed `dshDesktop` preload surface. So this needs a change on
 * the shell side, and this tool makes it locally, reversibly, in the installed `resources/app.asar`.
 *
 * What it inserts (in `lib/main.js`):
 *   - a tray menu item `messages.restartApplication + " " + messages.aboutProduct`
 *     ("Restart DeepSeek Harness" / "重启 DeepSeek Harness"), matching the naming of the Open and Quit entries;
 *   - the action behind it, `restart: () => { if (quitting) return; app.relaunch(); quitWithoutConfirmation(); }`,
 *     which is the shell's own code from its application menu — so Electron removes the tray icon itself instead of
 *     leaving a ghost icon behind, which is what happens when a process is killed.
 *
 * Commands
 *   status   say whether the installed archive carries the patch
 *   build    write `app.asar.new` from a pristine base and verify it file by file
 *   swap     close the application, put the new archive in place, relaunch, and restore the original if the
 *            application does not come back with a window
 *   detach   the same swap, but started as a process created through WMI: on Windows the application runs its
 *            descendants inside a job object, so a swapper started from inside it dies with it
 *   revert   put the original archive back and relaunch
 *
 * Options: `--install=<dir>`, `--asar=<file>`, `--log=<file>`, `--delay=<ms>` (with `detach`).
 *
 * The archive is rebuilt by shifting offsets rather than by replaying the asar format: only `lib/main.js` changes
 * size, so every file after it moves by a constant delta and every other byte is copied verbatim. The per-file
 * SHA256 in the index is recomputed for the patched file only, and the result is verified by reading it back and
 * comparing all files against the original.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOL = fileURLToPath(import.meta.url)
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const delayMs = Number(arg('delay') ?? 0)

let INSTALL = ''
let ASAR = ''
let STAGED = ''
let BACKUP = ''
let IMAGE = 'DeepSeek Harness.exe'
let PROCESS = 'DeepSeek Harness'
let LOG = path.join(process.env.TEMP ?? '.', 'dsh-tray-restart.log')

const log = (line) => {
  const text = `${new Date().toISOString()} ${line}\n`
  process.stdout.write(text)
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, text)
  } catch {}
}

/** Where the application is installed: an explicit option first, then the running process, then the default. */
function detectInstall() {
  const asar = arg('asar')
  if (asar !== undefined) return { install: path.dirname(path.dirname(asar)), asar }
  const install = arg('install')
  if (install !== undefined) return { install, asar: path.join(install, 'resources/app.asar') }
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)"`,
      { encoding: 'utf8' },
    ).trim()
    if (out !== '') return { install: path.dirname(out), asar: path.join(path.dirname(out), 'resources/app.asar') }
  } catch {}
  const fallback = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
  if (fs.existsSync(path.join(fallback, 'resources/app.asar'))) {
    return { install: fallback, asar: path.join(fallback, 'resources/app.asar') }
  }
  throw new Error('the DeepSeek Harness installation was not found — pass --install=<dir> or --asar=<file>')
}

function prepare() {
  const found = detectInstall()
  INSTALL = found.install
  ASAR = found.asar
  STAGED = `${ASAR}.new`
  BACKUP = `${ASAR}.orig`
  LOG = arg('log') ?? path.join(process.env.USERPROFILE ?? process.env.TEMP ?? '.', '.dsh', 'dsh-tray-restart', 'patch.log')
  if (!fs.existsSync(path.join(INSTALL, 'resources/app.asar'))) {
    throw new Error(`no resources/app.asar under ${INSTALL} — pass --install=<dir> or --asar=<file>`)
  }
  const exe = fs
    .readdirSync(INSTALL)
    .filter((name) => name.toLowerCase().endsWith('.exe') && !name.toLowerCase().startsWith('uninstall'))
    .find((name) => name.toLowerCase().includes('deepseek'))
  if (exe !== undefined) {
    IMAGE = exe
    PROCESS = exe.replace(/\.exe$/i, '')
  }
  log(`install: ${INSTALL}`)
}

const tasklist = () => execSync(`tasklist /FI "IMAGENAME eq ${IMAGE}" /NH`, { encoding: 'utf8' })
const appProcesses = () => {
  try {
    return tasklist().split('\n').filter((line) => line.includes(IMAGE)).length
  } catch {
    return 0
  }
}
const appExe = () => path.join(INSTALL, IMAGE)
const killAll = () => {
  try {
    execSync(`taskkill /F /IM "${IMAGE}"`, { stdio: 'ignore' })
  } catch {}
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function launch() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(appExe(), [], { detached: true, stdio: 'ignore', env, cwd: INSTALL })
  child.unref()
  log(`relaunched ${appExe()}`)
}

function hasWindow() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-Process -Name '${PROCESS}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty Id"`,
      { encoding: 'utf8' },
    )
    return out.trim() !== ''
  } catch {
    return false
  }
}

function walk(node, prefix, visit) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const where = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) walk(entry, where, visit)
    else visit(where, entry)
  }
}

function readAsar(file) {
  const buffer = fs.readFileSync(file)
  const jsonLength = buffer.readUInt32LE(12)
  if (buffer.readUInt32LE(0) !== 4 || 16 + jsonLength > buffer.length) {
    throw new Error(`this does not look like an asar archive (first bytes: ${buffer.subarray(0, 16).toString('hex')})`)
  }
  const index = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8').replace(/\0+$/, ''))
  return { buffer, index, dataOffset: 16 + jsonLength }
}

/**
 * Add the tray item to the shell's `lib/main.js`.
 *
 * Anchored on the actions rather than on line numbers: the tray's own Quit item is the `messages.quitApplication`
 * entry whose click calls `this.options.quit()`, and the tray is constructed with a `quit: () => { app.quit(); }`
 * option. Indentation is taken from the surrounding lines, never assumed.
 */
function patchMain(text) {
  const lines = text.split('\n')
  const indentOf = (line) => line.slice(0, line.length - line.trimStart().length)
  const out = []
  let trayItem = false
  let trayOption = false

  const quitLine = lines.findIndex(
    (line, i) => line.trim() === 'this.options.quit();' && lines[i - 1]?.trim() === 'click: () => {',
  )
  if (quitLine < 0) throw new Error('the tray Quit item was not found in lib/main.js')
  let separator = quitLine
  while (separator > 0 && lines[separator].trim() !== '{ type: "separator" },') separator -= 1
  if (separator === 0) throw new Error('the tray separator before Quit was not found')
  const trayIndent = indentOf(lines[separator])
  const trayEntry = [
    `${trayIndent}{`,
    `${trayIndent}\tlabel: messages.restartApplication + " " + messages.aboutProduct,`,
    `${trayIndent}\tclick: () => {`,
    `${trayIndent}\t\tthis.options.restart();`,
    `${trayIndent}\t}`,
    `${trayIndent}},`,
  ]

  const trayStart = lines.findIndex((line) => line.trim() === 'tray = new DesktopTray({')
  if (trayStart < 0) throw new Error('the DesktopTray construction was not found')
  let quitOption = -1
  for (let i = trayStart; i < Math.min(trayStart + 40, lines.length); i += 1) {
    if (lines[i].trim() === 'quit: () => {' && lines[i + 1]?.trim() === 'app.quit();') {
      quitOption = i
      break
    }
  }
  if (quitOption < 0) throw new Error('the tray quit option was not found')
  const optionIndent = indentOf(lines[quitOption])
  const optionEntry = [
    `${optionIndent}restart: () => {`,
    `${optionIndent}\tif (quitting) return;`,
    `${optionIndent}\tapp.relaunch();`,
    `${optionIndent}\tquitWithoutConfirmation();`,
    `${optionIndent}},`,
  ]

  for (let i = 0; i < lines.length; i += 1) {
    if (i === separator && !trayItem) {
      out.push(...trayEntry)
      trayItem = true
    }
    if (i === quitOption && !trayOption) {
      out.push(...optionEntry)
      trayOption = true
    }
    out.push(lines[i])
  }
  if (!trayItem || !trayOption) throw new Error('the patch did not apply to both places')
  return out.join('\n')
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

function build() {
  // The pristine archive is the base when it exists: patching an already patched archive would add the tray item
  // a second time.
  const base = fs.existsSync(BACKUP) ? BACKUP : ASAR
  log(`build: base archive is ${base}`)
  const { buffer, index, dataOffset } = readAsar(base)
  let mainEntry
  walk(index, '', (where, entry) => {
    if (where === 'lib/main.js') mainEntry = entry
  })
  if (mainEntry === undefined) throw new Error('lib/main.js is not in the archive')

  const oldOffset = Number(mainEntry.offset)
  const oldSize = Number(mainEntry.size)
  const before = buffer.subarray(dataOffset + oldOffset, dataOffset + oldOffset + oldSize)
  const patched = Buffer.from(patchMain(before.toString('utf8')), 'utf8')
  const delta = patched.length - oldSize
  log(`main.js: ${oldSize} -> ${patched.length} bytes (delta ${delta})`)

  const next = JSON.parse(JSON.stringify(index))
  walk(next, '', (where, entry) => {
    if (where === 'lib/main.js') {
      entry.size = patched.length
      entry.integrity = {
        algorithm: 'SHA256',
        hash: sha256(patched),
        blockSize: 4194304,
        blocks: [sha256(patched)],
      }
      return
    }
    if (entry.offset !== undefined && Number(entry.offset) > oldOffset) {
      entry.offset = String(Number(entry.offset) + delta)
    }
  })

  const json = Buffer.from(JSON.stringify(next), 'utf8')
  const padded = (json.length + 3) & ~3
  // The preamble is copied, not rebuilt: only the two length fields can legitimately change.
  const header = Buffer.from(buffer.subarray(0, 16))
  header.writeUInt32LE(8 + padded, 4)
  header.writeUInt32LE(padded, 12)
  const jsonBuffer = Buffer.alloc(padded)
  json.copy(jsonBuffer, 0)
  const head = buffer.subarray(dataOffset, dataOffset + oldOffset)
  const tail = buffer.subarray(dataOffset + oldOffset + oldSize)
  const output = Buffer.concat([header, jsonBuffer, head, patched, tail])
  fs.writeFileSync(STAGED, output)
  log(`staged ${STAGED} (${(output.length / 1024 / 1024).toFixed(1)} MB)`)

  // --- verification: read the new archive back and compare every file -----------
  const check = readAsar(STAGED)
  const oldFiles = new Map()
  const newFiles = new Map()
  walk(index, '', (where, entry) => oldFiles.set(where, entry))
  walk(check.index, '', (where, entry) => newFiles.set(where, entry))
  const slice = (source, entry) => {
    const offset = Number(entry.offset)
    return source.buffer.subarray(source.dataOffset + offset, source.dataOffset + offset + Number(entry.size))
  }
  let compared = 0
  let mismatched = 0
  let patchedSeen = false
  for (const [where, oldEntry] of oldFiles) {
    const newEntry = newFiles.get(where)
    if (newEntry === undefined) {
      mismatched += 1
      log(`MISSING in the new archive: ${where}`)
      continue
    }
    if (oldEntry.offset === undefined) continue
    const a = slice({ buffer, dataOffset }, oldEntry)
    const b = slice(check, newEntry)
    compared += 1
    if (where === 'lib/main.js') {
      patchedSeen = b.equals(patched)
      if (!patchedSeen) {
        mismatched += 1
        log('the patched main.js did not read back')
      }
    } else if (!a.equals(b)) {
      mismatched += 1
      log(`BYTES DIFFER: ${where}`)
    }
  }
  const integrity = sha256(slice(check, newFiles.get('lib/main.js'))) === newFiles.get('lib/main.js').integrity.hash
  log(`verified ${compared} files, ${mismatched} mismatches, patched main.js read back: ${patchedSeen}, integrity matches: ${integrity}`)
  if (mismatched !== 0 || !patchedSeen || !integrity) throw new Error('verification failed — nothing was swapped')
  log('build ok: the staged archive is ready; run `swap` or `detach`')
}

async function swap() {
  if (!fs.existsSync(STAGED)) throw new Error('no staged archive — run `build` first')
  log('swap: closing the application')
  killAll()
  for (let i = 0; i < 60 && appProcesses() > 0; i += 1) await sleep(500)
  log(`swap: ${appProcesses()} application process(es) left`)

  if (!fs.existsSync(BACKUP)) fs.copyFileSync(ASAR, BACKUP)
  if (fs.existsSync(`${ASAR}.replaced`)) fs.rmSync(`${ASAR}.replaced`)
  fs.renameSync(ASAR, `${ASAR}.replaced`)
  fs.renameSync(STAGED, ASAR)
  log('swap: patched archive is in place')
  launch()

  for (let i = 0; i < 40; i += 1) {
    await sleep(1000)
    if (hasWindow()) {
      log('swap: the application is back with a window — the tray menu now has Restart')
      return
    }
  }
  log('swap: the application did not come back — restoring the original archive')
  killAll()
  await sleep(2000)
  fs.renameSync(ASAR, `${ASAR}.broken`)
  fs.renameSync(BACKUP, ASAR)
  launch()
  log('swap: original restored and relaunched')
}

/**
 * Start the swap outside this process tree.
 *
 * A plain detached spawn is not enough on Windows: the application runs its descendants inside a job object, so
 * killing the application kills the swapper too — an attempt can die before it touches a single file. A process
 * created through WMI is owned by the WMI provider host instead, which the application cannot take down with itself.
 */
function detach() {
  const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 45000
  const inner = `"${process.execPath}" "${TOOL}" swap --delay=${delay}`.replace(/'/g, "''")
  const command = `powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner}' } | Out-Null"`
  execSync(command, { stdio: 'ignore' })
  log(`detach: a swapper outside this process tree will swap in ${Math.round(delay / 1000)}s and survives the application`)
}

function revert() {
  if (!fs.existsSync(BACKUP)) throw new Error('no backup to restore')
  log('revert: closing the application')
  killAll()
  for (let i = 0; i < 40 && appProcesses() > 0; i += 1) execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 500"', { stdio: 'ignore' })
  fs.copyFileSync(BACKUP, ASAR)
  log('revert: original archive restored')
  launch()
}

function status() {
  const { index, buffer, dataOffset } = readAsar(ASAR)
  let patched = false
  walk(index, '', (where, entry) => {
    if (where !== 'lib/main.js' || entry.offset === undefined) return
    const text = buffer
      .subarray(dataOffset + Number(entry.offset), dataOffset + Number(entry.offset) + Number(entry.size))
      .toString('utf8')
    patched = text.includes('this.options.restart();')
  })
  log(
    `status: carries the tray patch: ${patched} | staged: ${fs.existsSync(STAGED)} | backup: ${fs.existsSync(BACKUP)} | app processes: ${appProcesses()}`,
  )
}

function help() {
  process.stdout.write(
    [
      'dsh-desktop-tray-restart — add a Restart item to the DeepSeek Harness tray menu',
      '',
      '  status   say whether the installed archive carries the patch',
      '  build    write the staged archive from a pristine base and verify it file by file',
      '  detach   swap it in from a process the application cannot kill (recommended)',
      '  swap     swap it in now, closing the application first',
      '  revert   put the original archive back and relaunch',
      '',
      '  --install=<dir>  --asar=<file>  --log=<file>  --delay=<ms>',
      '',
    ].join('\n'),
  )
}

const command = process.argv[2]
if (command === undefined || command === 'help' || command === '--help') {
  help()
} else {
  try {
    prepare()
    if (Number.isFinite(delayMs) && delayMs > 0) {
      log(`${command}: starting in ${Math.round(delayMs / 1000)}s`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    if (command === 'build') build()
    else if (command === 'swap') await swap()
    else if (command === 'detach') detach()
    else if (command === 'revert') revert()
    else status()
  } catch (error) {
    log(`FAILED (${command}): ${error.message}`)
    process.exit(1)
  }
}
