#!/usr/bin/env node
/**
 * Publish this repository to GitHub as one commit, a tag and (through the release workflow) a Release.
 *
 * It exists because the previous pipeline lived outside the repository and built its tree on top of the branch's
 * existing tree with `base_tree`. That only ever adds and updates: a file deleted locally stayed in the repository,
 * and the mistake was invisible until someone compared a tag against the working tree. This tool **mirrors** the
 * working tree instead — files that are gone locally are deleted in the commit — and it can be asked what it would
 * do before it does anything.
 *
 * Usage
 *   node tools/release.mjs --dry-run              what would change (adds / updates / deletes)
 *   node tools/release.mjs --selftest             check the change detection itself
 *   node tools/release.mjs                        publish the version in package.json
 *   node tools/release.mjs --install=<profile>    …and point a DSH profile at the new tag
 *
 * Options
 *   --repo=<owner/name>   default IHS470/dsh-plugin-restart
 *   --branch=<name>       default main
 *   --token-file=<path>   default %USERPROFILE%\.dsh\gh-token.txt, or GITHUB_TOKEN
 *   --no-tests            skip `npm test`
 *   --message=<text>      commit message; default names the version and the changelog's first line
 *   --dry-run, --selftest
 *
 * Guards, because publishing is not a place to improvise:
 *   - the changelog must have a `## [<version>]` section (that section becomes the release notes);
 *   - the tag `v<version>` must not exist yet;
 *   - the test suite runs first unless `--no-tests`;
 *   - every file is addressed by its git blob hash, so "changed" means changed bytes.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const flag = (name) => process.argv.includes(`--${name}`)

const REPO = arg('repo') ?? 'IHS470/dsh-plugin-restart'
const BRANCH = arg('branch') ?? 'main'
const TOKEN = process.env.GITHUB_TOKEN ?? readToken(arg('token-file') ?? path.join(process.env.USERPROFILE ?? '.', '.dsh', 'gh-token.txt'))
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store'])
const IGNORED_EXT = ['.orig', '.bak', '.log', '.rej']

function readToken(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    throw new Error(`no GitHub token — pass --token-file=<path> or set GITHUB_TOKEN`)
  }
}

function api(url, init = {}) {
  return fetch('https://api.github.com' + url, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-release',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    ...init,
  }).then(async (response) => {
    if (response.status === 204) return undefined
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`)
    return text === '' ? undefined : JSON.parse(text)
  })
}

/** The git blob hash of a buffer: how git decides whether two files are the same. */
function blobHash(buffer) {
  return crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

/** Every file the release would publish, relative to the repository root. */
function localFiles(directory = ROOT, prefix = '') {
  const out = []
  for (const name of fs.readdirSync(directory).sort()) {
    if (IGNORED.has(name)) continue
    const full = path.join(directory, name)
    const where = prefix === '' ? name : `${prefix}/${name}`
    const stat = fs.statSync(full)
    if (stat.isDirectory()) out.push(...localFiles(full, where))
    else if (!IGNORED_EXT.some((extension) => name.endsWith(extension))) out.push(where)
  }
  return out
}

/**
 * What the commit would change.
 *
 * Pure on purpose, so `--selftest` can check the one thing that went wrong before: a path that exists in the
 * repository but not in the working tree must come out as a deletion, not as "nothing to do".
 */
export function plan(local, remote) {
  const added = []
  const updated = []
  const deleted = []
  for (const [where, hash] of local) {
    const before = remote.get(where)
    if (before === undefined) added.push(where)
    else if (before !== hash) updated.push(where)
  }
  for (const where of remote.keys()) if (!local.has(where)) deleted.push(where)
  return { added: added.sort(), updated: updated.sort(), deleted: deleted.sort() }
}

async function remoteFiles(treeSha) {
  const out = new Map()
  const tree = await api(`/repos/${REPO}/git/trees/${treeSha}?recursive=1`)
  for (const entry of tree.tree) {
    if (entry.type === 'blob') out.set(entry.path, entry.sha)
  }
  return out
}

function changelogSection(version) {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
  const start = text.indexOf(`## [${version}]`)
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`)
  const rest = text.slice(start)
  const next = rest.indexOf('\n## [', 1)
  return (next < 0 ? rest : rest.slice(0, next)).trim()
}

function runTests() {
  process.stdout.write('running the test suite…\n')
  execSync('npm test', { cwd: ROOT, stdio: 'inherit' })
}

async function publish() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const version = pkg.version
  const tag = `v${version}`
  const notes = changelogSection(version)
  const tests = flag('no-tests') ? false : true
  const dryRun = flag('dry-run')

  const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`)
  const head = await api(`/repos/${REPO}/git/commits/${ref.object.sha}`)
  const remote = await remoteFiles(head.tree.sha)
  const local = new Map(localFiles().map((where) => [where, blobHash(fs.readFileSync(path.join(ROOT, where)))]))

  const existingTag = await api(`/repos/${REPO}/git/ref/tags/${tag}`).catch(() => undefined)
  if (existingTag !== undefined) throw new Error(`${tag} already exists — bump the version instead of moving a tag`)

  const { added, updated, deleted } = plan(local, remote)
  process.stdout.write(`release ${tag} on ${REPO}@${BRANCH}\n`)
  for (const where of added) process.stdout.write(`  add    ${where}\n`)
  for (const where of updated) process.stdout.write(`  update ${where}\n`)
  for (const where of deleted) process.stdout.write(`  delete ${where}\n`)
  if (added.length + updated.length + deleted.length === 0) process.stdout.write('  (nothing differs)\n')

  if (dryRun) {
    process.stdout.write(`dry run: nothing was sent. Release notes would be the CHANGELOG section:\n${notes}\n`)
    return
  }
  if (tests) runTests()

  const entries = []
  for (const where of [...added, ...updated]) {
    const blob = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: fs.readFileSync(path.join(ROOT, where)).toString('base64'), encoding: 'base64' }),
    })
    entries.push({ path: where, mode: '100644', type: 'blob', sha: blob.sha })
  }
  // the whole point: paths that are gone locally are removed, not silently kept by base_tree
  for (const where of deleted) entries.push({ path: where, mode: '100644', type: 'blob', sha: null })

  const tree = await api(`/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: head.tree.sha, tree: entries }),
  })
  // The tag is the title; the changelog section is the body. Deriving a title from a markdown heading produced
  // things like "[2.0.1] - 2026-10-03", which is not a name anyone wants in a list of releases.
  const title = tag
  const body = notes.split('\n').slice(1).join('\n').trim()
  const message = arg('message') ?? `${tag}: ${notes.split('\n')[0].replace(/^#+\s*/, '').trim()}`
  const commit = await api(`/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
  })
  await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) })
  process.stdout.write(`commit ${commit.sha.slice(0, 8)} on ${BRANCH}\n`)

  await api(`/repos/${REPO}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commit.sha }) })
  process.stdout.write(`tag ${tag} -> ${commit.sha.slice(0, 8)}\n`)

  // The release workflow does not read the changelog, so the notes are published here. Creating the release
  // before the workflow reacts is what keeps its own placeholder body from becoming the public notes.
  const release = await api(`/repos/${REPO}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: title, body, draft: false, prerelease: false }),
  })
  process.stdout.write(`release ${release.html_url}\n`)

  const profile = arg('install')
  if (profile !== undefined) install(profile, version)
  process.stdout.write('done\n')
}

/** Point a DSH profile at the new tag: the dependency, the bundle list, and (if pnpm is reachable) the install. */
function install(profile, version) {
  const file = path.join(profile, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  const name = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name
  const url = `https://github.com/${REPO}/archive/refs/tags/v${version}.tar.gz`
  fs.copyFileSync(file, `${file}.before-${version}`)
  manifest.dependencies[name] = url
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(name)) bundles.push(name)
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`profile ${profile}: ${name} -> v${version}, bundle listed\n`)

  const runtime = process.env.LOCALAPPDATA === undefined
    ? undefined
    : path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies')
  const node = runtime === undefined ? undefined : path.join(runtime, 'node', 'bin', 'node.exe')
  const pnpm = runtime === undefined ? undefined : path.join(runtime, 'pnpm', 'bin', 'pnpm.mjs')
  if (node === undefined || pnpm === undefined || !fs.existsSync(pnpm)) {
    process.stdout.write('pnpm was not found; the profile is pointed at the tag but the install still has to be done\n')
    return
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execSync(`"${node}" "${pnpm}" add ${url} --dir "${profile}" --reporter=append-only`, { stdio: 'inherit' })
      process.stdout.write(`installed ${name} v${version} into the profile\n`)
      return
    } catch {
      process.stdout.write(`install attempt ${attempt} failed${attempt < 3 ? ', retrying' : ''}\n`)
    }
  }
  throw new Error('the profile was pointed at the tag, but pnpm could not install it')
}

/** The defect this tool exists for, tested: a path that is only in the repository is a deletion. */
function selftest() {
  const local = new Map([['kept.js', 'aaa'], ['changed.js', 'bbb'], ['new.js', 'ccc']])
  const remote = new Map([['kept.js', 'aaa'], ['changed.js', 'zzz'], ['gone.js', 'ddd']])
  const result = plan(local, remote)
  const expected = { added: ['new.js'], updated: ['changed.js'], deleted: ['gone.js'] }
  const actual = JSON.stringify(result)
  const wanted = JSON.stringify(expected)
  if (actual !== wanted) {
    process.stdout.write(`selftest FAILED\n  expected ${wanted}\n  actual   ${actual}\n`)
    process.exit(1)
  }
  if (blobHash(Buffer.from('x')) !== 'b2c3d4'.padEnd(40, '0').slice(0, 40) && blobHash(Buffer.from('x')).length !== 40) {
    process.stdout.write('selftest FAILED: blob hashes are not 40 hex characters\n')
    process.exit(1)
  }
  process.stdout.write('selftest ok: adds, updates and — the case that went wrong — deletions are all detected\n')
}

try {
  if (flag('selftest')) selftest()
  else await publish()
  // Node's fetch keeps idle sockets open, which would leave the process alive after a successful publish.
  process.exit(0)
} catch (error) {
  process.stdout.write(`FAILED: ${error.message}\n`)
  process.exit(1)
}
