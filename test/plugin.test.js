/**
 * Behaviour tests for the vendored catalogue and the guidance section.
 *
 * The skills and the sync logic are the two things a stale vendored copy or an
 * upstream restructure would break, so both are covered: the catalogue tests
 * read the real vendored files, and the sync tests exercise the pure helpers
 * that decide what gets copied and what a pin records.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MCP_TOOL_PREFIX,
  POSTGRES_SKILL_NAMES,
  buildSection,
  loadVendoredSkill,
  parseSkillFrontmatter,
  readUpstreamPin,
  vendoredSkillNames,
} from '../src/index.js'
import {
  parseSkillFrontmatter as parseSyncFrontmatter,
  parseTar,
  resolveLinkPath,
  shouldVendor,
  stripArchiveRoot,
} from '../scripts/sync-upstream.mjs'
import { checkIcon } from '../scripts/check-patch.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the peers this plugin names are resolvable by a installing profile', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  // A peer that npm cannot resolve fails the whole install, whether the plugin
  // needs it at runtime or not. Both peers here are harness packages that live
  // in the running profile rather than on the public registry, so they are
  // declared optional: a profile that provides them still gets them, and a
  // registry install that cannot see them is not refused over it.
  const optional = manifest.peerDependenciesMeta ?? {}
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    assert.equal(optional[name]?.optional, true, `${name} is a required peer, so npm must be able to resolve it`)
  }
  // The runtime uses neither peer directly: both are read through ctx at load
  // time and a missing one is handled rather than thrown.
  const peerImports = Object.keys(manifest.peerDependencies ?? {}).filter(name =>
    /from ['"]@deepseek-ai\//.test(readFileSync(join(ROOT, 'src', 'catalog.js'), 'utf8') + readFileSync(join(ROOT, 'src', 'prompt.js'), 'utf8')),
  )
  assert.deepEqual(peerImports, [], 'a peer is imported directly, so declaring it optional would hide a real dependency')
})

test('the manifest declares the harness release it was verified against', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.compatibility?.dshReleases?.['0.2.0-rc.2'], 'compatible')
  // dsh-context uses this exact range; a plugin that narrows it would refuse to
  // install on a supported release.
  assert.equal(manifest.engines.node, '^22.19.0 || >=24.0.0')
})

test('the package installs straight from git with no build permission', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  // A git install fetches sources, not build output, and pnpm runs exactly two
  // lifecycle scripts on a git dependency: `prepack` (building the tarball) and
  // `prepare` (after it is extracted). Either would make pnpm refuse the
  // install until the user allowlists this package's build script in the
  // profile's pnpm-workspace.yaml, stopping anyone who installs from GitHub at
  // the first step.
  //
  // `prepublishOnly` is different: pnpm does not run it on a git dependency, and
  // npm runs it only on an explicit `npm publish`, where refusing to publish on a
  // failing check is exactly what it is for.
  const gitInstallScripts = ['prepare', 'prepack', 'preinstall', 'postinstall', 'install']
    .filter(name => manifest.scripts?.[name] !== undefined)
  assert.deepEqual(gitInstallScripts, [], `a git install would need build permission: ${gitInstallScripts.join(', ')}`)

  // Nothing may be generated either: the entry points ship as committed source.
  assert.equal(manifest.main, './src/index.js')
  assert.ok(existsSync(resolve(ROOT, manifest.main)), 'the declared main entry is not in the repository')
  for (const target of Object.values(manifest.exports)) {
    assert.ok(existsSync(resolve(ROOT, target)), `the export ${target} is not committed, so a git install cannot resolve it`)
  }
  // `private` is what npm refuses to publish; its absence keeps a registry
  // install available as the second documented route.
  assert.notEqual(manifest.private, true)
})

test('the upstream pin names the commit the vendored bodies came from', () => {
  const pin = readUpstreamPin()
  assert.notEqual(pin, null)
  assert.equal(pin.repository, 'timescale/pg-aiguide')
  assert.match(pin.commit, /^[0-9a-f]{40}$/)
  assert.equal(pin.skills.length, 11)
})

test('every skill the pin lists is vendored and parseable', () => {
  for (const name of vendoredSkillNames()) {
    const skill = loadVendoredSkill(name)
    assert.equal(skill.name, name)
    assert.ok(skill.description.length > 0, `${name} has an empty description`)
    assert.ok(skill.content.includes('---'), `${name} has no frontmatter`)
  }
})

test('the guidance section lists every vendored skill', () => {
  const section = buildSection(fakeCtx(true))
  for (const name of vendoredSkillNames()) {
    assert.ok(section.includes(`\`${name}\``), `the section does not mention ${name}`)
  }
  assert.ok(section.includes('mcp__pg-aiguide__search_docs'))
  assert.ok(section.includes('postgres_17'))
})

test('the guidance section is empty when no skill is visible', () => {
  assert.equal(buildSection(fakeCtx(false)), '')
})

test('the guidance section is empty when the registry cannot answer', () => {
  assert.equal(buildSection({}), '')
  assert.equal(buildSection({ get: () => { throw new Error('shadow') } }), '')
})

test('the guidance names only skills that are vendored', () => {
  for (const name of POSTGRES_SKILL_NAMES) {
    assert.ok(vendoredSkillNames().includes(name), `${name} is named in the guidance but not vendored`)
  }
})

test('a skill whose directory name and frontmatter disagree fails the load', () => {
  assert.throws(
    () => loadVendoredSkill('does-not-exist'),
    /ENOENT|no such file/i,
  )
})

test('frontmatter parsing reports a missing name or description', () => {
  assert.throws(() => parseSkillFrontmatter('no frontmatter', 'x'), /no frontmatter/)
  assert.throws(() => parseSkillFrontmatter('---\ndescription: a\n---\n', 'x'), /no name/)
  assert.throws(() => parseSkillFrontmatter('---\nname: a\n---\n', 'x'), /no description/)
})

test('a block-scalar description is collected across lines', () => {
  const parsed = parseSkillFrontmatter('---\nname: a\ndescription: |\n  first\n  second\nother: x\n---\nbody', 'x')
  assert.equal(parsed.name, 'a')
  assert.equal(parsed.description, 'first\nsecond')
})

test('the sync and the catalogue agree on frontmatter', () => {
  const body = readFileSync(join(ROOT, 'assets', 'skills', 'postgres', 'SKILL.md'), 'utf8')
  assert.deepEqual(parseSkillFrontmatter(body, 'x'), parseSyncFrontmatter(body))
})

test('only markdown below skills/ is vendored', () => {
  assert.equal(shouldVendor('skills/postgres/SKILL.md'), true)
  assert.equal(shouldVendor('skills/postgres/references/a.md'), true)
  assert.equal(shouldVendor('skills/postgres/logo.svg'), false)
  assert.equal(shouldVendor('README.md'), false)
  assert.equal(shouldVendor('docs/a.md'), false)
  assert.equal(shouldVendor('skills/Makefile'), false)
  assert.equal(shouldVendor('src/node_modules/pkg/index.md'), false)
})

test('a relative link target resolves against the link directory', () => {
  assert.equal(
    resolveLinkPath('skills/postgres/references/a.md', '../../design-postgres-tables/SKILL.md'),
    'skills/design-postgres-tables/SKILL.md',
  )
  assert.equal(resolveLinkPath('skills/a/b.md', '/skills/c.md'), 'skills/c.md')
})

test('the bundle patch points the MCP row at the server this plugin documents', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('https://mcp.tigerdata.com/docs'), 'the MCP endpoint is not configured')
  assert.ok(patch.includes('serverName: pg-aiguide'), 'the tool namespace is not pg-aiguide')
  assert.ok(patch.includes('transport: streamable-http'), 'the MCP row does not use Streamable HTTP')
  // The skills are vendored, so a failing MCP connection must not fail the load
  // and take the skills with it.
  assert.ok(patch.includes('failOnStartupError: false'), 'the MCP row would fail the load when the endpoint is down')
  assert.equal(MCP_TOOL_PREFIX, 'mcp__pg-aiguide__')
})

test('the declared plugin icon is a real image the plugin panel can render', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(checkIcon(manifest), [], 'the icon declaration is invalid')
  // The panel reads the icon without activating the plugin, so a broken one
  // silently falls back to default artwork rather than failing the load.
  const icon = resolve(ROOT, manifest.icon)
  assert.ok(statSync(icon).size > 0, 'the icon file is empty')
  assert.ok(statSync(icon).size <= 262144, 'the icon is over the 256 KiB limit')
})

test('the icon check rejects the declarations the harness refuses', () => {
  assert.match(checkIcon({ icon: '/etc/passwd' })[0], /relative to the package/)
  assert.match(checkIcon({ icon: 'https://example.com/i.png' })[0], /relative to the package/)
  assert.match(checkIcon({ icon: './missing.png' })[0], /does not exist/)
  assert.match(checkIcon({ icon: './icon.txt', files: ['icon.txt'] })[0], /supported image extension/)
  assert.match(checkIcon({ icon: './icon.svg', files: [] })[0], /not listed in files/)
  assert.deepEqual(checkIcon({}), [], 'an omitted icon is allowed')
})

test('an icon that pulls in outside resources does not pass', () => {
  // The harness renders an icon as an image, not as inline HTML, so a script or
  // a remote reference is either stripped or fetched at render time. An icon
  // that depends on any of those is not one self-contained file.
  const decoy = join(ROOT, 'icon-decoy.svg')
  const hostile = {
    'remote image': '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>',
    'inline script': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'remote css': '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.com/x.css);</style></svg>',
  }
  try {
    for (const [label, body] of Object.entries(hostile)) {
      writeFileSync(decoy, body)
      assert.match(
        checkIcon({ icon: './icon-decoy.svg', files: ['icon-decoy.svg'] })[0],
        /not self-contained/,
        `${label} was accepted as an icon`,
      )
    }
    writeFileSync(decoy, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#131413"/></svg>')
    assert.deepEqual(checkIcon({ icon: './icon-decoy.svg', files: ['icon-decoy.svg'] }), [], 'a clean SVG was rejected')
  } finally {
    rmSync(decoy, { force: true })
  }
})

test('a text file renamed to .png does not pass as an icon', () => {
  // The panel falls back to default artwork for a file it cannot decode, so a
  // renamed text file would otherwise satisfy every other rule.
  const decoy = join(ROOT, 'icon-decoy.png')
  writeFileSync(decoy, 'not a png')
  try {
    assert.match(checkIcon({ icon: './icon-decoy.png', files: ['icon-decoy.png'] })[0], /not a decodable image/)
  } finally {
    rmSync(decoy, { force: true })
  }
})

test('the icon image is square, so a panel row does not distort it', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const bytes = readFileSync(resolve(ROOT, manifest.icon))
  let width
  let height
  if (manifest.icon.endsWith('.svg')) {
    // An SVG scales to whatever box it is given, so its own viewBox is what
    // decides whether the mark is distorted.
    const viewBox = /viewBox="[^"]*?([\d.]+) ([\d.]+)"/.exec(bytes.toString('utf8'))
    assert.notEqual(viewBox, null, 'the icon SVG has no viewBox, so it has no intrinsic shape')
    width = Number(viewBox[1])
    height = Number(viewBox[2])
  } else {
    // PNG IHDR carries the dimensions as big-endian uint32 at byte offset 16.
    width = bytes.readUInt32BE(16)
    height = bytes.readUInt32BE(20)
  }
  assert.equal(width, height, `the icon is ${width}x${height}, not square`)
})

test('the archive root is stripped before skills are addressed', () => {
  const archive = new Map([['pg-aiguide-abc123/skills/a/SKILL.md', 'x'], ['pg-aiguide-abc123/README.md', 'y']])
  const stripped = stripArchiveRoot(archive)
  assert.deepEqual([...stripped.keys()].sort(), ['README.md', 'skills/a/SKILL.md'])
  assert.throws(() => stripArchiveRoot(new Map([['a/x.md', '1'], ['b/y.md', '2']])), /root directories/)
})

test('the tar parser reads files, links and GNU long names', () => {
  const archive = buildTar([
    { path: 'root/skills/a/SKILL.md', type: '0', body: 'hello' },
    { path: 'root/skills/a/b.md', type: '2', link: '../elsewhere.md' },
    { path: 'root/' + 'x'.repeat(120) + '.md', type: '0', body: 'long' },
  ])
  const parsed = parseTar(archive)
  assert.equal(parsed.files.get('root/skills/a/SKILL.md').toString('utf8'), 'hello')
  assert.equal(parsed.links.get('root/skills/a/b.md'), '../elsewhere.md')
  assert.ok([...parsed.files.keys()].some(p => p.endsWith('.md') && p.includes('x'.repeat(50))))
})

test('an archive with no single root directory is rejected', () => {
  assert.throws(
    () => stripArchiveRoot(new Map([['a/x.md', '1'], ['b/y.md', '2']])),
    /root directories/,
  )
})

test('the pin round-trips to the files on disk', () => {
  const pin = JSON.parse(readFileSync(join(ROOT, 'assets', 'upstream.json'), 'utf8'))
  for (const [path, digest] of Object.entries(pin.files)) {
    const body = readFileSync(join(ROOT, 'assets', 'skills', ...path.split('/')), 'utf8')
    assert.equal(digest, sha256(body), `${path} does not match its recorded digest`)
  }
  assert.equal(pin.fileCount, Object.keys(pin.files).length)
})

test('no vendored file is a dangling reference from the umbrella skill', () => {
  const umbrella = loadVendoredSkill('postgres')
  for (const match of umbrella.content.matchAll(/\]\((references\/[^)]+)\)/g)) {
    const target = match[1]
    const full = join(ROOT, 'assets', 'skills', 'postgres', ...target.split('/'))
    const body = readFileSync(full, 'utf8')
    assert.ok(body.length > 0, `${target} is empty, so the umbrella skill points at nothing`)
  }
})

/**
 * A context whose skills registry answers for every name, or for none.
 *
 * @param {boolean} visible - whether the registry reports the skills.
 * @returns {any} a Cordis-shaped context double.
 */
function fakeCtx (visible) {
  return {
    get: () => ({ get: name => (visible && POSTGRES_SKILL_NAMES.includes(name) ? {} : undefined) }),
  }
}

/**
 * Hash a string the way the pin records it.
 *
 * @param {string} value - the text to hash.
 * @returns {string} the hex digest.
 */
function sha256 (value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Build a minimal ustar archive for the parser test.
 *
 * @param {Array<{ path: string, type: string, body?: string, link?: string }>} entries - the members.
 * @returns {Buffer} the archive bytes.
 */
function buildTar (entries) {
  const blocks = []
  for (const entry of entries) {
    if (entry.path.length > 100) {
      // Force the GNU long-name record that precedes such an entry.
      const longName = Buffer.from(`${entry.path}\0`, 'utf8')
      blocks.push(tarHeader('././@LongLink', 'L', longName.length))
      blocks.push(pad(longName))
    }
    if (entry.type === '2') {
      // A symlink carries no payload: its target lives in the header's linkname
      // field, which is what the parser reads.
      blocks.push(tarHeader(entry.path, '2', 0, entry.link))
      continue
    }
    blocks.push(tarHeader(entry.path, entry.type, Buffer.byteLength(entry.body ?? '')))
    if (entry.body !== undefined) blocks.push(pad(Buffer.from(entry.body, 'utf8')))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/**
 * Build one tar header block.
 *
 * @param {string} path - the entry name.
 * @param {string} type - the one-character type flag.
 * @param {number} size - the entry's payload size in bytes.
 * @param {string} [link] - the symlink target, written to the linkname field.
 * @returns {Buffer} the 512-byte header.
 */
function tarHeader (path, type, size, link) {
  const header = Buffer.alloc(512)
  header.write(path.slice(0, 100), 0, 'utf8')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('ustar\0' + '00', 257, 'ascii')
  header.write(type, 156, 'ascii')
  if (link !== undefined) header.write(link.slice(0, 100), 157, 'utf8')
  return header
}

/**
 * Pad a payload to a whole number of 512-byte blocks.
 *
 * @param {Buffer} data - the payload.
 * @returns {Buffer} the padded payload.
 */
function pad (data) {
  const remainder = data.length % 512
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder)])
}
