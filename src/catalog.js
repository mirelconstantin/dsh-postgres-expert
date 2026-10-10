/**
 * The vendored skill catalogue.
 *
 * The bodies live under `assets/skills/<name>/`, mirroring pg-aiguide's own
 * layout, so a skill's `references/` resolve relative to its own directory.
 * Nothing is downloaded at runtime: the plugin serves files from the package.
 *
 * @module dsh-postgres-expert/catalog
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The root of the vendored skills inside this package. */
export const SKILLS_ROOT = new URL('../assets/skills/', import.meta.url)

/** The provider label the registry records for these contributions. */
export const SKILL_PROVIDER = 'dsh-postgres-expert'

/**
 * Read the upstream pin, which records the commit the vendored bodies came from.
 *
 * @returns {{ repository: string, ref: string, commit: string, skills: string[] } | null}
 *   the pin, or null when the package was assembled without one.
 */
export function readUpstreamPin () {
  try {
    const pin = JSON.parse(readFileSync(new URL('../assets/upstream.json', import.meta.url), 'utf8'))
    return {
      repository: pin.repository,
      ref: pin.ref,
      commit: pin.commit,
      skills: Array.isArray(pin.skills) ? pin.skills : [],
    }
  } catch {
    // A missing or unreadable pin costs the provenance line, not the skills.
    return null
  }
}

/**
 * Read the frontmatter `name` and `description` from a vendored SKILL.md.
 *
 * The same rules the sync script applies, repeated here so a bad vendored file
 * fails the load with a message naming the skill rather than registering an
 * unaddressable one.
 *
 * @param {string} content - the raw SKILL.md contents.
 * @param {string} origin - the file's path, for error messages.
 * @returns {{ name: string, description: string }} the parsed fields.
 * @throws {Error} when either field is missing.
 */
export function parseSkillFrontmatter (content, origin) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1]
  if (block === undefined) throw new Error(`${origin}: no frontmatter block`)

  const name = /^name:[ \t]*(.*)$/m.exec(block)?.[1].trim().replace(/^["']|["']$/g, '')
  if (name === undefined || name === '') throw new Error(`${origin}: frontmatter has no name`)

  const description = readDescription(block)
  if (description === null) throw new Error(`${origin}: frontmatter has no description`)
  return { name, description }
}

/**
 * Read the `description` frontmatter value, which pg-aiguide writes as a block
 * scalar spanning many lines.
 *
 * @param {string} block - the frontmatter text without its fences.
 * @returns {string | null} the description, or null when the key is absent.
 */
function readDescription (block) {
  const inline = /^description:[ \t]*(.*)$/m.exec(block)
  if (inline === null) return null
  const first = inline[1].trim()
  if (!['|', '>', '|-', '>-'].includes(first)) return first.replace(/^["']|["']$/g, '')

  const start = block.indexOf('\n', inline.index) + 1
  if (start <= 0) return ''
  const lines = []
  for (const line of block.slice(start).split(/\r?\n/)) {
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
 * Read one vendored skill directory into a registry contribution.
 *
 * @param {string} name - the skill directory name.
 * @returns {{ name: string, description: string, content: string, path: string, resourceBase: { kind: 'directory', path: string } }}
 *   the registration for one skill.
 * @throws {Error} when the directory has no SKILL.md, or the body has no frontmatter.
 */
export function loadVendoredSkill (name) {
  const directory = new URL(`${name}/`, SKILLS_ROOT)
  const bodyUrl = new URL('SKILL.md', directory)
  const content = readFileSync(bodyUrl, 'utf8')
  const path = dirname(fileURLToPath(bodyUrl))
  const { name: declared, description } = parseSkillFrontmatter(content, `assets/skills/${name}/SKILL.md`)
  if (declared !== name) {
    throw new Error(`assets/skills/${name}/SKILL.md declares name "${declared}"`)
  }
  return { name, description, content, path, resourceBase: { kind: 'directory', path } }
}

/**
 * The names of every vendored skill.
 *
 * Read from the upstream pin rather than by scanning the directory, so the
 * catalogue is exactly what the sync recorded. A pin listing a skill whose files
 * are absent fails loudly in {@link loadVendoredSkill} instead of silently
 * contributing fewer skills than the pin claims.
 *
 * @returns {string[]} the vendored skill names.
 */
export function vendoredSkillNames () {
  const pin = readUpstreamPin()
  if (pin === null || pin.skills.length === 0) {
    throw new Error('dsh-postgres-expert: assets/upstream.json is missing or lists no skills')
  }
  return [...pin.skills]
}

/**
 * Join a vendored skill directory onto a package path.
 *
 * @param {...string} parts - path segments below the skills root.
 * @returns {string} the absolute path.
 */
export function skillsPath (...parts) {
  return join(fileURLToPath(SKILLS_ROOT), ...parts)
}
