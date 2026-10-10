/**
 * The system-prompt section that tells every model PostgreSQL expertise is here.
 *
 * @module dsh-postgres-expert/prompt
 */

/**
 * The vendored skills this guidance is written about.
 *
 * Declared as literals rather than imported from the catalogue so this module
 * holds no dependency on the registry: the section's provider runs during a
 * prompt assembly on a different fiber, where the skills themselves may have
 * been filtered out of the scope being assembled.
 *
 * @type {readonly string[]}
 */
export const POSTGRES_SKILL_NAMES = Object.freeze([
  'postgres',
  'design-postgres-tables',
  'design-postgis-tables',
  'schema-exploration',
  'postgres-database-migration',
  'pgvector-semantic-search',
  'postgres-hybrid-text-search',
  'setup-timescaledb-hypertables',
  'find-hypertable-candidates',
  'migrate-postgres-tables-to-hypertables',
  'timescaledb-hyperfunctions',
])

/**
 * The MCP server's tool namespace, from the `serverName` in `cordis.patch.yml`.
 */
export const MCP_TOOL_PREFIX = 'mcp__pg-aiguide__'

/**
 * Whether at least one vendored skill is visible in one scope.
 *
 * Resolved through `ctx.get('skills')` rather than the `ctx.skills` property:
 * this runs during prompt assembly on a different fiber, where a direct
 * property read can throw through a traceable shadow. `skills.get(name, scope)`
 * is the registry's own visibility resolver and answers `undefined` for a name a
 * restriction filtered away. `list()` is async and cannot answer a synchronous
 * assembly question, so it is deliberately not used.
 *
 * Every failure path reports false: a registry that cannot answer is no reason
 * to inject guidance about skills that may not be there.
 *
 * @param {any} ctx - the Cordis context.
 * @param {any} [scope] - the scope key this assembly is resolving.
 * @returns {boolean} whether a vendored skill is visible.
 */
export function postgresSkillVisible (ctx, scope) {
  let skills
  try {
    skills = typeof ctx?.get === 'function' ? ctx.get('skills') : undefined
  } catch {
    return false
  }
  if (!skills || typeof skills.get !== 'function') return false
  try {
    return POSTGRES_SKILL_NAMES.some(name => skills.get(name, scope) !== undefined)
  } catch {
    return false
  }
}

/**
 * Render the section text for one assembly.
 *
 * @param {any} ctx - the Cordis context.
 * @param {any} [scope] - the scope key this assembly is resolving.
 * @returns {string} the section text, or the empty string when nothing is visible.
 */
export function buildSection (ctx, scope) {
  if (!postgresSkillVisible(ctx, scope)) return ''
  return `## PostgreSQL expertise

Curated PostgreSQL guidance from Tiger Data's pg-aiguide is installed on this machine. Load it with the \`skill\` tool rather than answering from memory, which is usually wrong about modern versions.

Skills, each addressing one area:

- \`postgres\` — umbrella router. Load this first for any PostgreSQL task; it points at the right reference.
- \`design-postgres-tables\` — table design, data types, constraints, indexes, JSONB, partitioning.
- \`design-postgis-tables\` — spatial table design, SRIDs, spatial indexes.
- \`schema-exploration\` — read-only exploration of an existing database through \`pg_catalog\`. Use before changing a schema you have not read.
- \`postgres-database-migration\` — zero-downtime DDL, lock levels, backfills, rollback.
- \`pgvector-semantic-search\` — vector indexes, filtered search, tuning.
- \`postgres-hybrid-text-search\` — BM25 and semantic search fused with RRF.
- \`setup-timescaledb-hypertables\`, \`find-hypertable-candidates\`, \`migrate-postgres-tables-to-hypertables\` — TimescaleDB time-series.
- \`timescaledb-hyperfunctions\` — hyperfunctions for aggregation and analysis.

For version-exact manual detail, the \`${MCP_TOOL_PREFIX}search_docs\` tool searches the official PostgreSQL manual by version, plus Tiger Data and PostGIS documentation. Its \`source\` argument carries both corpus and version, for example \`postgres_17\`, \`tiger\` or \`postgis_3.4\`; there is no separate version argument. Prefer it over recalling syntax.`
}
