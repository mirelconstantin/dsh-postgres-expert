/**
 * dsh-postgres-expert — PostgreSQL expertise as native harness surfaces.
 *
 * The package is a bundle, not a single plugin: its `cordis.patch.yml` inserts
 * three independent rows, the vendored skills, the guidance section, and the
 * MCP client connection to Tiger Data's pg-aiguide server. This module exists to
 * publish the vendored catalogue as a value and to keep the package importable
 * by tests and tooling; loading the bundle does not load this file.
 *
 * @module dsh-postgres-expert
 */

export {
  SKILL_PROVIDER,
  SKILLS_ROOT,
  loadVendoredSkill,
  parseSkillFrontmatter,
  readUpstreamPin,
  vendoredSkillNames,
} from './catalog.js'
export {
  MCP_TOOL_PREFIX,
  POSTGRES_SKILL_NAMES,
  buildSection,
  postgresSkillVisible,
} from './prompt.js'

/** Plugin identity. */
export const name = 'dsh-postgres-expert'
