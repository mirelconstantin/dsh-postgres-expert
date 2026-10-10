/**
 * Mirror pg-aiguide's skills from upstream into `assets/skills/`.
 *
 * The vendored copies are what the plugin serves, so this script is the only
 * thing that decides whether the plugin is current. It is deliberately
 * reproducible: the same upstream commit always produces byte-identical output,
 * so a diff in review is a real upstream change and nothing else.
 *
 * Two modes:
 *   `node scripts/sync-upstream.mjs`          rewrite assets/skills/ and the pin
 *   `node scripts/sync-upstream.mjs --check`  fail if the pin or any vendored
 *                                             file differs from what upstream would give
 *
 * `--check` is what CI runs, so an upstream change that nobody synced fails the
 * build instead of sitting stale in a published package.
 *
 * Upstream is read as one repository tarball rather than through the contents
 * API. A per-file API walk costs one unauthenticated request per file and runs
 * out of GitHub's rate limit partway through; the tarball is a single request
 * regardless of how many skills upstream ships.
 *
 * @module dsh-postgres-expert/sync-upstream
 */

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** Upstream repository the vendored skills come from. */
export const UPSTREAM_REPO = 'timescale/pg-aiguide'

/** Upstream branch the vendored skills are taken from. */
export const UPSTREAM_REF = 'main'

/** Where the vendored skills live inside this package. */
export const SKILLS_DIR = join(ROOT, 'assets', 'skills')

/** The file that records which upstream commit produced the vendored copies. */
export const PIN_FILE = join(ROOT, 'assets', 'upstream.json')

/** One tar header block, the fixed size of the ustar format. */
const TAR_BLOCK = 512

/**
 * File extensions copied out of the upstream tree.
 *
 * `.md` holds the skill bodies and their reference files. Binary assets are
 * skipped: a skill body may reference an image, but shipping it would make the
 * vendored output depend on a download that a review cannot read.
 *
 * @type {ReadonlySet<string>}
 */
const COPIED_EXTENSIONS = new Set(['.md'])

/**
 * Directory names never copied, at any depth.
 *
 * @type {ReadonlySet<string>}
 */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.github', '__pycache__'])

/**
 * Read a tar header field as a NUL-padded string.
 *
 * @param {Buffer} block - one 512-byte header block.
 * @param {number} offset - the field's byte offset.
 * @param {number} length - the field's byte length.
 * @returns {string} the trimmed field.
 */
function tarString (block, offset, length) {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8').trim()
}

/**
 * Read a tar header's size field, which is octal ASCII.
 *
 * @param {Buffer} block - one 512-byte header block.
 * @returns {number} the entry size in bytes.
 */
function tarSize (block) {
  const field = tarString(block, 124, 12)
  return field === '' ? 0 : Number.parseInt(field, 8)
}

/**
 * Parse a tar archive into its regular files and symbolic links.
 *
 * Only the parts of ustar a GitHub tarball uses are handled: a `prefix` joined
 * to `name`, and the GNU long-name records the format allows before a name that
 * does not fit.
 *
 * Symbolic links are kept as links rather than resolved, because whether a link
 * survives a checkout depends on the platform and on `core.symlinks`, and the
 * vendored tree must be the same on every machine that runs this script.
 *
 * @param {Buffer} archive - the uncompressed tar bytes.
 * @returns {{ files: Map<string, Buffer>, links: Map<string, string> }} regular
 *   files keyed by full archive path, and links mapped to their raw target.
 */
export function parseTar (archive) {
  const files = new Map()
  const links = new Map()
  let offset = 0
  let longName = null

  while (offset + TAR_BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK)
    // Two consecutive zero blocks end the archive.
    if (header.every(byte => byte === 0)) break
    offset += TAR_BLOCK

    const size = tarSize(header)
    const data = archive.subarray(offset, offset + size)
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK

    const typeflag = String.fromCharCode(header[156])
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const path = longName ?? (prefix === '' ? name : `${prefix}/${name}`)
    longName = null

    if (typeflag === 'L') {
      // The record's payload is the next entry's name, not an entry itself.
      longName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (typeflag === '2') {
      // A symlink stores its target in `linkname`, not in the data block.
      links.set(path, tarString(header, 157, 100))
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      files.set(path, Buffer.from(data))
    }
  }
  return { files, links }
}

/**
 * Resolve one link target against the path that declared it.
 *
 * A target is either relative to the link's own directory or absolute within
 * the archive.
 *
 * @param {string} linkPath - the archive path of the link.
 * @param {string} target - the raw `linkname` value.
 * @returns {string} the absolute archive path the link refers to.
 */
export function resolveLinkPath (linkPath, target) {
  if (target.startsWith('/')) return target.slice(1)
  const parts = linkPath.split('/')
  parts.pop()
  for (const segment of target.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Copy each link's target contents into the link's own path.
 *
 * pg-aiguide's `postgres` umbrella skill points its `references/` at the
 * sibling skills with relative symlinks. A checkout may or may not materialise
 * those — Windows clones without symlink support leave the paths empty, and an
 * npm tarball keeps them as links that the consumer's platform may not support —
 * so a skill body that references them would resolve to nothing. Writing the
 * real contents makes the vendored tree self-contained and identical everywhere.
 *
 * A link whose target is missing or outside `skills/` is a packaging error and
 * is reported rather than skipped: it would otherwise become a broken reference
 * in a published package.
 *
 * @param {Map<string, Buffer>} files - every regular file in the archive.
 * @param {Map<string, string>} links - every link mapped to its raw target.
 * @param {string} skillsPrefix - the archive path prefix the vendored tree starts at.
 * @returns {Map<string, Buffer>} the files plus one copy per resolvable link.
 * @throws {Error} when a link cannot be resolved.
 */
export function materializeLinks (files, links, skillsPrefix) {
  const resolved = new Map(files)
  for (const [linkPath, target] of links) {
    if (!linkPath.startsWith(skillsPrefix)) continue
    // A link to a directory has no contents of its own. Its files appear under
    // their own real paths and are already vendored, so there is nothing to copy.
    const source = resolveLinkPath(linkPath, target)
    if (files.has(source)) {
      resolved.set(linkPath, files.get(source))
      continue
    }
    if (isDirectoryPath(files, source)) continue
    throw new Error(`upstream link ${linkPath} points at ${target}, which is not in the archive`)
  }
  return resolved
}

/**
 * Whether an archive path is a directory rather than a file.
 *
 * GitHub's tarballs mark a directory with a trailing slash on the entry name, so
 * the check is the name's own suffix.
 *
 * @param {Map<string, unknown>} files - the archive paths already collected.
 * @param {string} path - the archive path to test.
 * @returns {boolean} true when the path names a directory.
 */
function isDirectoryPath (files, path) {
  if (path.endsWith('/')) return true
  for (const candidate of files.keys()) {
    if (candidate.startsWith(`${path}/`)) return true
  }
  return false
}

/**
 * Whether a path inside the archive should be vendored.
 *
 * The `skills/` prefix is required here rather than at the call site so the
 * rule is stated once: a markdown file anywhere else in the upstream repository
 * is not part of the plugin.
 *
 * @param {string} path - the archive path, relative to the archive root.
 * @returns {boolean} true when the file is copied.
 */
export function shouldVendor (path) {
  if (!path.startsWith('skills/')) return false
  const parts = path.split('/')
  if (parts.some(part => SKIPPED_DIRECTORIES.has(part))) return false
  const name = parts[parts.length - 1]
  const dot = name.lastIndexOf('.')
  return dot > 0 && COPIED_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/**
 * Read the frontmatter `name:` and `description:` of a skill body.
 *
 * A skill the plugin cannot address, or cannot route, is a packaging error, so
 * this reports a missing key rather than defaulting one. pg-aiguide writes
 * `description` as a YAML block scalar, so the value may span lines and is
 * collected until the next key at the same indentation.
 *
 * @param {string} content - the raw SKILL.md contents.
 * @returns {{ name: string, description: string }} the parsed fields.
 * @throws {Error} when the frontmatter or either key is missing.
 */
export function parseSkillFrontmatter (content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) throw new Error('SKILL.md has no frontmatter block')
  const block = match[1]

  const name = /^name:[ \t]*(.*)$/m.exec(block)
  if (!name) throw new Error('SKILL.md frontmatter has no name')
  const trimmedName = name[1].trim().replace(/^["']|["']$/g, '')
  if (trimmedName === '') throw new Error('SKILL.md frontmatter has an empty name')

  const description = readBlockScalar(block, 'description')
  if (description === null) throw new Error('SKILL.md frontmatter has no description')
  return { name: trimmedName, description }
}

/**
 * Read one frontmatter key that may be a single line or a block scalar.
 *
 * @param {string} block - the frontmatter text, without the `---` fences.
 * @param {string} key - the frontmatter key to read.
 * @returns {string | null} the value, or null when the key is absent.
 */
function readBlockScalar (block, key) {
  const inline = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block)
  if (!inline) return null
  const first = inline[1].trim()
  if (!['|', '>', '|-', '>-'].includes(first)) {
    return first.replace(/^["']|["']$/g, '')
  }
  const start = block.indexOf('\n', inline.index) + 1
  if (start <= 0) return ''
  const lines = []
  for (const line of block.slice(start).split(/\r?\n/)) {
    // A blank line inside the block belongs to it; the block ends at the first
    // non-blank line that is not indented past the key.
    if (line.trim() === '') {
      lines.push('')
      continue
    }
    if (!/^\s/.test(line)) break
    lines.push(line.replace(/^[ \t]+/, ''))
  }
  const joined = first.startsWith('>') ? lines.join(' ') : lines.join('\n')
  return joined.trim()
}

/**
 * Fetch the upstream repository as a tarball.
 *
 * @param {string} ref - branch, tag or commit to read.
 * @returns {Promise<Buffer>} the gzipped tar bytes.
 * @throws {Error} when the download fails.
 */
async function downloadTarball (ref) {
  const url = `https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${encodeURIComponent(ref)}`
  const response = await fetch(url, {
    headers: {
      'user-agent': 'dsh-postgres-expert-sync',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`cannot download ${UPSTREAM_REPO}@${ref}: ${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Resolve the commit a ref points at.
 *
 * `git ls-remote` is used rather than the commits API because it needs no
 * credentials and no GitHub rate limit, and this script runs unattended in CI
 * on a schedule — a limit it can hit is a sync that silently stops happening.
 * One request resolves the sha, and the tarball is then downloaded at that sha
 * rather than at the branch, so a second sync cannot read a different tree than
 * the one the pin records, even if the branch moves between the two requests.
 *
 * @param {string} ref - branch, tag or commit.
 * @returns {Promise<string>} the full commit sha.
 * @throws {Error} when the ref cannot be resolved.
 */
async function resolveCommit (ref) {
  const { stdout } = await execFile('git', ['ls-remote', `https://github.com/${UPSTREAM_REPO}.git`, ref], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  const sha = stdout.split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`cannot resolve ${UPSTREAM_REPO}@${ref}: ls-remote returned ${JSON.stringify(stdout.trim())}`)
  }
  return sha
}

/**
 * Strip the archive's single root directory, which GitHub names after the repo
 * and the requested ref.
 *
 * @param {Map<string, Buffer | string>} archive - the parsed archive.
 * @returns {Map<string, Buffer | string>} the same entries keyed by their path below the root.
 * @throws {Error} when the archive has no single root directory.
 */
export function stripArchiveRoot (archive) {
  const roots = new Set()
  for (const path of archive.keys()) {
    const slash = path.indexOf('/')
    if (slash > 0) roots.add(path.slice(0, slash))
  }
  if (roots.size !== 1) throw new Error(`upstream archive has ${roots.size} root directories, expected 1`)
  const prefix = `${[...roots][0]}/`
  const stripped = new Map()
  for (const [path, data] of archive) {
    if (path.startsWith(prefix)) stripped.set(path.slice(prefix.length), data)
  }
  return stripped
}

/**
 * Build the complete vendored tree from upstream.
 *
 * @param {string} ref - branch, tag or commit to read.
 * @returns {Promise<{ commit: string, files: Map<string, string>, skills: Array<{ name: string, description: string }> }>}
 *   the resolved commit, every file keyed by its path under `assets/skills/`, and the parsed skills.
 * @throws {Error} when upstream exposes no skills or a skill cannot be parsed.
 */
export async function buildTree (ref) {
  const commit = await resolveCommit(ref)
  const parsed = parseTar(gunzipSync(await downloadTarball(commit)))
  const strippedFiles = stripArchiveRoot(parsed.files)
  const strippedLinks = stripArchiveRoot(parsed.links)
  const archive = materializeLinks(strippedFiles, strippedLinks, 'skills/')

  const files = new Map()
  for (const [path, data] of archive) {
    if (!path.startsWith('skills/') || !shouldVendor(path)) continue
    files.set(path.slice('skills/'.length), data.toString('utf8'))
  }

  const skillDirectories = [...new Set([...files.keys()]
    .filter(path => path.endsWith('/SKILL.md'))
    .map(path => path.slice(0, -'/SKILL.md'.length)))]
    .sort()
  if (skillDirectories.length === 0) throw new Error('upstream exposes no skills')

  const skills = []
  for (const directory of skillDirectories) {
    const body = files.get(`${directory}/SKILL.md`)
    const parsed = parseSkillFrontmatter(body)
    if (parsed.name !== directory.split('/')[0]) {
      throw new Error(`upstream skill ${directory} declares name "${parsed.name}"`)
    }
    skills.push({ name: parsed.name, description: parsed.description })
  }

  return { commit, files, skills }
}

/**
 * Render the pin file for one vendored tree.
 *
 * The per-file digest is what makes `--check` able to tell a real upstream
 * change from a reordering or a line-ending difference.
 *
 * @param {string} commit - the upstream commit the tree was read at.
 * @param {Map<string, string>} files - every vendored file keyed by package-relative path.
 * @returns {string} the serialized pin.
 */
export function renderPin (commit, files) {
  const digests = {}
  for (const path of [...files.keys()].sort()) {
    digests[path] = createHash('sha256').update(files.get(path), 'utf8').digest('hex')
  }
  return `${JSON.stringify({
    upstream: `https://github.com/${UPSTREAM_REPO}`,
    repository: UPSTREAM_REPO,
    ref: UPSTREAM_REF,
    commit,
    license: 'Apache-2.0',
    notice: 'Copyright 2025 Timescale, Inc., d/b/a Tiger Data. See NOTICE.',
    fileCount: files.size,
    skills: [...new Set([...files.keys()].filter(p => p.endsWith('/SKILL.md')).map(p => p.split('/')[0]))].sort(),
    files: digests,
  }, null, 2)}\n`
}

/**
 * List every file currently vendored, as package-relative POSIX paths.
 *
 * @param {string} dir - the directory to walk.
 * @param {string} [prefix] - the path of `dir` relative to the package root.
 * @returns {Promise<string[]>} the sorted paths.
 */
async function listVendored (dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...await listVendored(join(dir, entry.name), next))
    else found.push(next)
  }
  return found.sort()
}

/**
 * Write one file, creating its directory.
 *
 * @param {string} path - the absolute destination path.
 * @param {string} content - the file contents.
 * @returns {Promise<void>} nothing.
 */
async function writeFileAt (path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/**
 * Report whether the vendored tree and the pin match what upstream would give.
 *
 * @param {{ commit: string | null, files: Map<string, string>, skills: unknown[] }} tree - the freshly built tree.
 * @returns {Promise<string[]>} one line per difference; empty when current.
 */
async function findDrift (tree) {
  const problems = []
  const existing = await listVendored(SKILLS_DIR).catch(() => [])
  const wanted = [...tree.files.keys()]

  for (const path of wanted) {
    const current = await readFile(join(SKILLS_DIR, ...path.split('/')), 'utf8').catch(() => null)
    if (current === null) problems.push(`missing assets/skills/${path}`)
    else if (current !== tree.files.get(path)) problems.push(`stale assets/skills/${path}`)
  }
  for (const path of existing) {
    if (!tree.files.has(path)) problems.push(`unexpected assets/skills/${path}`)
  }

  const currentPin = await readFile(PIN_FILE, 'utf8').catch(() => null)
  const wantedPin = renderPin(tree.commit, tree.files)
  if (currentPin === null) problems.push('missing assets/upstream.json')
  else if (currentPin !== wantedPin) problems.push('stale assets/upstream.json')
  return problems
}

/**
 * Run the sync in one mode or the other.
 *
 * @returns {Promise<void>} nothing.
 */
async function main () {
  const check = process.argv.includes('--check')
  const tree = await buildTree(UPSTREAM_REF)
  const problems = await findDrift(tree)
  const label = tree.commit ?? 'an unidentifiable upstream commit'

  if (check) {
    if (problems.length > 0) {
      process.stderr.write(`dsh-postgres-expert is not up to date with ${UPSTREAM_REPO}:\n`)
      for (const problem of problems) process.stderr.write(`  ${problem}\n`)
      process.stderr.write('Run `npm run sync` and commit the result.\n')
      process.exitCode = 1
      return
    }
    process.stdout.write(`dsh-postgres-expert matches ${UPSTREAM_REPO}@${label} (${tree.skills.length} skills).\n`)
    return
  }

  await rm(SKILLS_DIR, { recursive: true, force: true })
  await mkdir(SKILLS_DIR, { recursive: true })
  for (const path of [...tree.files.keys()].sort()) {
    await writeFileAt(join(SKILLS_DIR, ...path.split('/')), tree.files.get(path))
  }
  await writeFileAt(PIN_FILE, renderPin(tree.commit, tree.files))
  process.stdout.write(`synced ${tree.files.size} files and ${tree.skills.length} skills from ${UPSTREAM_REPO}@${label}\n`)
}

// Only run when invoked directly, so the module stays importable from tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
