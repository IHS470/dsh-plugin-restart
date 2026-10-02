/**
 * Local patch: add a Restart item to the tray menu of the installed DeepSeek Harness desktop shell.
 *
 * Why this is a tool and not a plugin feature: the tray belongs to the shell's main process (`new Tray`,
 * `setContextMenu`). A plugin lives in the host (plain Node, no Electron API) and in the page (only the fixed
 * `dshDesktop` preload surface), so it cannot add a tray item. See `docs/dsh-restart-api-request.zh.md` for the
 * two-line change the shell itself should carry.
 *
 * What it does:
 *   build   read `resources/app.asar`, patch `lib/main.js` in memory, write `app.asar.new`, then verify the new
 *           archive byte for byte against the original (every other file must be identical).
 *   swap    close the app, put the new archive in place, relaunch, and **restore the original automatically** if
 *           the app does not come back with a window.
 *   revert  put the original archive back and relaunch.
 *   status  say which archive is in place and whether it carries the patch.
 *
 * The archive is rebuilt by shifting offsets rather than by replaying the asar format: only `lib/main.js` changes
 * size, so every file after it moves by a constant delta and the rest of the bytes are copied verbatim. The
 * per-file SHA256 in the index is recomputed for the patched file only, which is where it can matter.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOL = fileURLToPath(import.meta.url)
const INSTALL = 'C:/Users/mayih/AppData/Local/Programs/DeepSeek Harness'
const ASAR = path.join(INSTALL, 'resources/app.asar')
const STAGED = `${ASAR}.new`
const BACKUP = `${ASAR}.orig`
const LOG = path.join(process.env.USERPROFILE ?? '.', '.dsh/dsh-plugin-restart/shell-patch.log')

const log = (line) => {
  const text = `${new Date().toISOString()} ${line}\n`
  process.stdout.write(text)
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, text)
  } catch {}
}

/** Walk the asar index and hand every file entry to `visit`, with its path for messages. */
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
  const json = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8').replace(/\0+$/, ''))
  return { buffer, index: json, dataOffset: 16 + jsonLength }
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

  // 1. the tray menu: insert a Restart item before the separator that precedes Quit
  const quitLine = lines.findIndex((line, i) => line.trim() === 'this.options.quit();' && lines[i - 1]?.trim() === 'click: () => {')
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

  // 2. the tray construction: pass the restart action the application menu already uses
  const trayStart = lines.findIndex((line) => line.trim() === 'tray = new DesktopTray({')
  if (trayStart < 0) throw new Error('the DesktopTray construction was not found')
  let quitOption = -1
  for (let i = trayStart; i < Math.min(trayStart + 40, lines.length); i += 1) {
    if (lines[i].trim() === 'quit: () => {' && lines[i + 1]?.trim() === 'app.quit();') { quitOption = i; break }
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
    if (i === separator && !trayItem) { out.push(...trayEntry); trayItem = true }
    if (i === quitOption && !trayOption) { out.push(...optionEntry); trayOption = true }
    out.push(lines[i])
  }
  if (!trayItem || !trayOption) throw new Error('the patch did not apply to both places')
  return out.join('\n')
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function build() {
  // The pristine archive is the base when it exists: patching an already patched archive would add the tray
  // item a second time.
  const base = fs.existsSync(BACKUP) ? BACKUP : ASAR
  log(`build: base archive is ${base}`)
  const { buffer, index, dataOffset } = readAsar(base)
  let mainEntry = undefined
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

  // shift every file that lives after the patched one; nothing else changes
  const next = JSON.parse(JSON.stringify(index))
  walk(next, '', (where, entry) => {
    if (where === 'lib/main.js') {
      entry.size = patched.length
      entry.integrity = { algorithm: 'SHA256', hash: sha256(patched), blockSize: 4194304, blocks: [sha256(patched)] }
      return
    }
    if (entry.offset !== undefined && Number(entry.offset) > oldOffset) entry.offset = String(Number(entry.offset) + delta)
  })

  const json = Buffer.from(JSON.stringify(next), 'utf8')
  const padded = (json.length + 3) & ~3
  // The preamble is copied, not rebuilt: only the two length fields can legitimately change.
  const header = Buffer.from(buffer.subarray(0, 16))
  header.writeUInt32LE(8 + padded, 4)
  header.writeUInt32LE(padded, 12)
  const jsonBuffer = Buffer.alloc(padded)
  json.copy(jsonBuffer, 0)

  const tail = buffer.subarray(dataOffset + oldOffset + oldSize)
  const head = buffer.subarray(dataOffset, dataOffset + oldOffset)
  const output = Buffer.concat([header, jsonBuffer, head, patched, tail])
  fs.writeFileSync(STAGED, output)
  log(`staged ${STAGED} (${(output.length / 1024 / 1024).toFixed(1)} MB)`)

  // --- verification: read the new archive back and compare every file -----------
  const check = readAsar(STAGED)
  const oldFiles = new Map()
  walk(index, '', (where, entry) => oldFiles.set(where, entry))
  let compared = 0
  let mismatched = 0
  let patchedSeen = false
  const readFileFrom = (source, entry) => {
    const offset = Number(entry.offset)
    return source.buffer.subarray(source.dataOffset + offset, source.dataOffset + offset + Number(entry.size))
  }
  const newFiles = new Map()
  walk(check.index, '', (where, entry) => newFiles.set(where, entry))
  for (const [where, oldEntry] of oldFiles) {
    const newEntry = newFiles.get(where)
    if (newEntry === undefined) { mismatched += 1; log(`MISSING in the new archive: ${where}`); continue }
    if (oldEntry.offset === undefined) continue
    const a = readFileFrom({ buffer, dataOffset }, oldEntry)
    const b = readFileFrom(check, newEntry)
    compared += 1
    if (where === 'lib/main.js') {
      patchedSeen = b.equals(patched)
      if (!patchedSeen) { mismatched += 1; log('the patched main.js did not read back') }
    } else if (!a.equals(b)) {
      mismatched += 1
      log(`BYTES DIFFER: ${where}`)
    }
  }
  const integrity = sha256(readFileFrom(check, newFiles.get('lib/main.js'))) === newFiles.get('lib/main.js').integrity.hash
  log(`verified ${compared} files, ${mismatched} mismatches, patched main.js read back: ${patchedSeen}, integrity matches: ${integrity}`)
  if (mismatched !== 0 || !patchedSeen || !integrity) throw new Error('verification failed — nothing was swapped')
  log('build ok: app.asar.new is ready; run `swap` when the app may be closed')
  return true
}

function appProcesses() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', { encoding: 'utf8' })
    return out.split('\n').filter((line) => line.includes('DeepSeek Harness.exe')).length
  } catch {
    return 0
  }
}

function appExe() {
  const entries = fs.readdirSync(INSTALL).filter((name) => name.toLowerCase().endsWith('.exe'))
  const exe = entries.find((name) => name.toLowerCase() === 'deepseek harness.exe') ?? entries.find((name) => name.toLowerCase().includes('deepseek'))
  if (exe === undefined) throw new Error(`the application executable was not found (saw: ${entries.join(', ')})`)
  return path.join(INSTALL, exe)
}

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
      'powershell -NoProfile -Command "Get-Process -Name \'DeepSeek Harness\' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty Id"',
      { encoding: 'utf8' },
    )
    return out.trim() !== ''
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function swap() {
  if (!fs.existsSync(STAGED)) throw new Error('no staged archive — run `build` first')
  log('swap: closing the application')
  try {
    execSync('taskkill /F /IM "DeepSeek Harness.exe"', { stdio: 'ignore' })
  } catch {}
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
  try { execSync('taskkill /F /IM "DeepSeek Harness.exe"', { stdio: 'ignore' }) } catch {}
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
 * killing the application kills the swapper too — the first attempt died exactly there, before it had touched a
 * single file. A process created through WMI is owned by the WMI provider host instead, which the application
 * cannot take down with itself.
 */
function detach() {
  const delay = Number(process.argv[3] ?? 60000)
  const inner = `"${process.execPath}" "${TOOL}" swap ${delay}`.replace(/'/g, "''")
  const command = `powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner}' } | Out-Null"`
  execSync(command, { stdio: 'ignore' })
  log(`detach: a swapper outside this process tree will swap in ${Math.round(delay / 1000)}s and survives the application`)
}
function revert() {
  if (!fs.existsSync(BACKUP)) throw new Error('no backup to restore')
  log('revert: closing the application')
  try { execSync('taskkill /F /IM "DeepSeek Harness.exe"', { stdio: 'ignore' }) } catch {}
  const wait = Date.now() + 20000
  while (Date.now() < wait && appProcesses() > 0) {
    execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 400"', { stdio: 'ignore' })
  }
  fs.copyFileSync(BACKUP, ASAR)
  log('revert: original archive restored')
  launch()
}

function status() {
  const staged = fs.existsSync(STAGED)
  const backup = fs.existsSync(BACKUP)
  const { index, buffer, dataOffset } = readAsar(ASAR)
  let patched = false
  walk(index, '', (where, entry) => {
    if (where !== 'lib/main.js' || entry.offset === undefined) return
    const text = buffer.subarray(dataOffset + Number(entry.offset), dataOffset + Number(entry.offset) + Number(entry.size)).toString('utf8')
    patched = text.includes('this.options.restart();')
  })
  log(`status: installed archive carries the tray patch: ${patched} | staged: ${staged} | backup: ${backup} | app processes: ${appProcesses()}`)
}

const command = process.argv[2]
const delay = Number(process.argv[3] ?? 0)
if (Number.isFinite(delay) && delay > 0) {
  log(`${command}: starting in ${Math.round(delay / 1000)}s`)
  await new Promise((resolve) => setTimeout(resolve, delay))
}
try {
  if (command === 'build') build()
  else if (command === 'swap') await swap()
  else if (command === 'detach') detach()
  else if (command === 'revert') revert()
  else status()
} catch (error) {
  log(`FAILED (${command}): ${error.message}`)
  process.exit(1)
}
