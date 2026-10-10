/**
 * The gate that runs before every publish.
 *
 * A published version is permanent: npm will not let the same name and version
 * be used again even after an unpublish, so a broken or stale artifact is not a
 * thing to fix afterwards. This refuses the publish instead.
 *
 * It checks, in order:
 *   - every gate in CI, so a publish cannot differ from a green build
 *   - that the version in `package.json` is not already on the registry
 *   - that the working tree is committed, so the published artifact is exactly
 *     what the repository says it is
 *   - that the tag is pushed, so `npm install dsh-postgres-expert` and the GitHub
 *     tag point at the same release
 *
 * `npm publish` also runs this. `npm run prepublish` runs it without publishing,
 * which is how to check everything except the last step on its own.
 *
 * @module dsh-postgres-expert/prepublish
 */

import { execFile as execFileCallback } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://registry.npmjs.org'

/**
 * The npm executable for this platform.
 *
 * `npm` resolves through the `.cmd` shim on Windows, which a spawned process
 * cannot find by bare name unless the shim directory is on its own PATH. Using
 * `process.execPath` with the npm CLI's JavaScript entry avoids the shim
 * entirely, and avoids assuming npm is on PATH at all.
 *
 * @type {{ command: string, args: string[] }} the executable and its leading arguments.
 */
const NPM = {
  command: process.execPath,
  args: [resolveNpmCli()],
}

/**
 * Locate the npm CLI entry point that ships with this Node installation.
 *
 * @returns {string} the absolute path to npm-cli.js.
 * @throws {Error} when it cannot be found.
 */
function resolveNpmCli () {
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(bundled)) return bundled
  throw new Error(`cannot find npm-cli.js next to ${process.execPath}; run this gate with npm itself`)
}

/**
 * Run npm through the resolved CLI.
 *
 * @param {string[]} args - the npm arguments.
 * @returns {Promise<string>} the stdout.
 */
function npm (args) {
  return run(NPM.command, [...NPM.args, ...args])
}

/**
 * Run a command and return its stdout.
 *
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @returns {Promise<string>} the stdout.
 */
async function run (command, args) {
  const { stdout } = await execFile(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/**
 * Report whether a version of this package already exists on the registry.
 *
 * @param {string} name - the unscoped package name.
 * @param {string} version - the exact version.
 * @returns {Promise<boolean>} true when that name and version is taken.
 */
async function alreadyPublished (name, version) {
  try {
    await npm(['view', `${name}@${version}`, 'version', '--registry', REGISTRY])
    return true
  } catch {
    // A 404 is the answer we want: the version is free.
    return false
  }
}

/**
 * Run every publish gate and report the first failure.
 *
 * @returns {Promise<string | null>} a human-readable problem, or null when clear.
 */
export async function checkPublishable () {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  // The gates CI runs, so a publish cannot differ from a green build.
  for (const [label, args] of [
    ['the behaviour tests', ['test']],
    ['the upstream freshness check', ['run', 'sync:check']],
  ]) {
    try {
      await npm(args)
    } catch (error) {
      return `${label} failed:\n${error.stderr || error.stdout || error.message}`
    }
  }
  try {
    await run('node', ['scripts/check-patch.mjs'])
  } catch (error) {
    return `the bundle patch check failed:\n${error.stderr || error.stdout || error.message}`
  }

  if (await alreadyPublished(manifest.name, manifest.version)) {
    return `${manifest.name}@${manifest.version} is already on the registry. A published name and version can never be reused, even after an unpublish, so bump the version instead:\n  npm version ${nextVersion(manifest.version)}`
  }

  // The published artifact must be the committed one: a dirty tree means the
  // registry and the repository would disagree about what version 1.0.0 is.
  const status = (await run('git', ['status', '--porcelain'])).trim()
  if (status !== '') {
    return `the working tree has uncommitted changes:\n${status}\nCommit them, or nothing that is published will match the repository.`
  }

  const head = (await run('git', ['rev-parse', 'HEAD'])).trim()
  const tag = await tagForVersion(manifest.version)
  if (tag !== null) {
    const tagged = (await run('git', ['rev-list', '-n', '1', tag])).trim()
    if (tagged !== head) {
      return `the ${tag} tag points at ${tagged.slice(0, 7)}, not at HEAD (${head.slice(0, 7)}).\nMove it, or the tag and the published version would describe different code:\n  git tag -f ${tag} ${head}\n  git push -f origin ${tag}`
    }
  }
  return null
}

/**
 * The version a failed publish should be bumped to.
 *
 * @param {string} version - the current version.
 * @returns {string} the next patch version.
 */
function nextVersion (version) {
  const [major, minor, patch] = version.split('.').map(Number)
  return `${major}.${minor}.${(patch ?? 0) + 1}`
}

/**
 * The git tag for a release version, or null when the tree carries no tags.
 *
 * @param {string} version - the release version.
 * @returns {Promise<string | null>} the tag name, or null.
 */
async function tagForVersion (version) {
  const candidate = `v${version}`
  const tags = await run('git', ['tag', '--list', candidate])
  return tags.trim() === '' ? null : candidate
}

// Only run when invoked directly, so the module stays importable from tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problem = await checkPublishable()
  if (problem !== null) {
    process.stderr.write(`dsh-postgres-expert cannot be published: ${problem}\n`)
    process.exitCode = 1
  } else {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    process.stdout.write(`dsh-postgres-expert ${manifest.version} is ready to publish.\n`)
  }
}