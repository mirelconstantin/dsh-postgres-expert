<p align="center">
  <img src="https://raw.githubusercontent.com/pazalo/.github/main/assets/pazalo-logo.png" width="112" alt="Pazalo">
</p>

<h1 align="center">dsh-postgres-expert</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D23.4-FFC24D?style=flat-square&logo=node&logoColor=black" alt="Node">
  <img src="https://img.shields.io/badge/Skills-11-FFC24D?style=flat-square" alt="Skills">
  <img src="https://img.shields.io/badge/Tests-23-FFC24D?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/Licence-Apache--2.0-F0522C?style=flat-square" alt="Licence">
</p>

<p align="center">
  PostgreSQL expertise for DeepSeek Harness. Eleven curated skills from
  Tiger Data's pg-aiguide, registered as native skills, plus the public MCP
  server for version-exact manual search — so the model stops writing 2015-era
  schemas from memory.
</p>

## Install

Anyone can install this. It needs a DeepSeek Harness profile, and nothing else —
no API key, no database and no account, because the only network call it makes is
an optional documentation search against a public endpoint.

From the GUI, paste this into **Add plugin** and pick **Official npm registry**
unless you have changed the default:

```
github:mirelconstantin/dsh-postgres-expert
```

Or from a terminal:

```bash
dsh plugin add github:mirelconstantin/dsh-postgres-expert
```

**No build step is involved.** Every entry point ships as committed source, so
pnpm never has to run this package's scripts and you are never asked to
allowlist a build. Restart the profile afterwards and three rows appear.

<details>
<summary>Asking an agent instead</summary>

You can also just say *"install the `dsh-postgres-expert` plugin in this
profile"* and the agent will run the same install for you — it has a
`plugin_manager install_bundle` tool and writes the bundle for you. You do not
need this route, and it is not shorter; it is there because installing from an
agent is occasionally the only option available, such as over a remote host.

One thing to know if you use it: installing a package means its code runs on
your machine, so the agent will ask for approval first. That prompt is the
point, not an obstacle.

</details>

<details>
<summary>Installing by other routes</summary>

| Route | Command |
| --- | --- |
| Published to npm | `dsh plugin add dsh-postgres-expert` |
| Pinned to a commit | `dsh plugin add github:mirelconstantin/dsh-postgres-expert#<sha>` |
| Tarball | `dsh plugin add ./dsh-postgres-expert-1.0.0.tgz` |
| Local checkout | `dsh plugin add /absolute/path/to/dsh-postgres-expert` |
| As a profile dependency | see below |

The GitHub route above needs nothing but git access. The npm route, once
published, is the shortest: no git, no `github:` prefix, and pnpm resolves it
from the registry.

As a profile dependency, add it to `package.json` and to `dsh.profile.bundles`:

```json
{
  "dependencies": {
    "dsh-postgres-expert": "github:mirelconstantin/dsh-postgres-expert"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-postgres-expert"]
    }
  }
}
```

</details>

## What it adds

| Row | What it does |
| --- | --- |
| `postgres-expert-skills` | registers the 11 vendored skills on `ctx.skills` |
| `postgres-expert-prompt` | the system-prompt section that makes the guidance known |
| `postgres-expert-mcp` | connects the public pg-aiguide MCP server over Streamable HTTP |

The rows are independent. **`postgres-expert-mcp` is the only one that touches
the network**, so disabling it leaves the curated skills working entirely
offline:

```yaml
- id: postgres-expert-mcp
  disabled: true
```

Overriding that row replaces its whole `config` object, so re-declare every
field you still want. The fields are the
[`@deepseek-ai/dsh-mcp-client` configuration](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/config-catalog.md#deepseek-aidsh-mcp-client):
`transport`, `serverName`, `url`, `headers`, `toolCallTimeoutMs`,
`failOnStartupError`, `maxInstructionBytes` and `reconnect`.

## The skills

| Skill | Covers |
| --- | --- |
| `postgres` | umbrella router; points at the right reference for any PostgreSQL task |
| `design-postgres-tables` | data types, constraints, indexes, JSONB, partitioning |
| `design-postgis-tables` | spatial design, geometry vs geography, SRIDs, spatial indexes |
| `schema-exploration` | read-only exploration of an existing database through `pg_catalog` |
| `postgres-database-migration` | zero-downtime DDL, lock levels, backfills, rollback |
| `pgvector-semantic-search` | vector indexes, filtered search, tuning |
| `postgres-hybrid-text-search` | BM25 and semantic search fused with RRF |
| `setup-timescaledb-hypertables` | hypertables, compression, retention, continuous aggregates |
| `find-hypertable-candidates` | SQL that scores existing tables for hypertable conversion |
| `migrate-postgres-tables-to-hypertables` | partition-column choice, in-place vs blue-green, validation |
| `timescaledb-hyperfunctions` | hyperfunctions for aggregation and analysis |

## How they load themselves

You do not have to invoke a skill, and you do not have to remember a name. The
harness does the routing, and it happens before the model ever decides anything:

1. **Every skill announces itself.** At the first step of a session the harness
   injects an `<available_skills>` catalog carrying each skill's name and
   description — nothing else, no bodies. Each session gets this
   automatically.
2. **The descriptions are the routing table.** They are written for it: pg-aiguide
   packs each description with trigger phrases and a keyword line (`PostgreSQL,
   Postgres, schema, table design, indexes, constraints, hypertable, semantic
   search, …`). That is what makes the match, not anything this plugin does.
3. **The model loads the one it needs.** When the task is PostgreSQL, the model
   calls `skill({ name })` by itself. That is the whole mechanism.

So "when it is about postgres" is already the behaviour: ask for a schema and
the model loads `postgres` or `design-postgres-tables` on its own. Ask about
React and nothing loads, because the catalog is the only thing in the prompt.

This plugin's own `postgres-expert-prompt` section reinforces it by naming the
skills and the MCP tool, so the model does not have to infer the tools exist.

The one thing this cannot do is override a deliberate restriction: a preset's
`tools.restrict({ allow: [...] })`, a subagent's `toolFilter` or a disabled
`postgres-expert-skills` row removes the skills from that scope, and the prompt
section withdraws itself with them rather than advertising tools it cannot
reach.

Bodies load on demand, so a session that never touches PostgreSQL pays nothing
for any of this.

## The MCP connection

The harness connects to `https://mcp.tigerdata.com/docs`, negotiates the
protocol, discovers the tools and exposes each as an ordinary harness tool with
cancellation, permission checks and recorded results. It does not host or
supervise the server — Tiger Data runs it.

Upstream exposes exactly two tools:

| Tool | Arguments |
| --- | --- |
| `mcp__pg-aiguide__search_docs` | `source`, `query`, optional `limit` (default 20) and `semanticWeight` (0 keyword → 1 semantic, default 0.7) |
| `mcp__pg-aiguide__view_skill` | `name`, optional `path` |

`source` carries **both corpus and version in one value** — `tiger`,
`postgres_14` … `postgres_18`, `postgis_3.3` … `postgis_3.6`. There is no
separate version argument.

`view_skill` overlaps with the skills vendored here, which is why the skills are
registered natively rather than read back over MCP.

Discovery is asynchronous: after a restart, wait for the `mcp__pg-aiguide__*`
tools before sending the first prompt that needs them. If the endpoint is
unreachable the bundle still loads, `failOnStartupError: false` keeps it that
way, and the reconnect policy retries with backoff.

## Staying current

The vendored skills under `assets/skills/` are what the plugin serves, so a copy
that is not synced is a package serving stale advice.

**`assets/upstream.json` is the provenance.** It records the upstream commit, a
SHA-256 digest per file, and the licence the copy was taken under — so the exact
upstream state this package corresponds to is reviewable without fetching
anything.

```bash
npm run sync          # rewrite assets/skills/ and the pin from upstream
npm run sync:check    # fail if the vendored tree differs from what upstream gives
npm test              # behaviour tests over the catalogue and the sync helpers
```

A GitHub Actions workflow runs `sync` daily and opens a pull request when
upstream has moved. CI runs `sync:check` on **Linux and Windows** on every push
and pull request, so a package cannot be published against a stale mirror.

<details>
<summary>How the sync reads upstream</summary>

One repository tarball, with the sha resolved by `git ls-remote` — so it needs no
GitHub token and cannot exhaust the API rate limit on a schedule. Two details of
the upstream tree are handled explicitly:

- **Symlinks are materialised.** pg-aiguide's `postgres` umbrella skill points
  its `references/` at the sibling skills with relative symlinks. Those links do
  not survive every checkout or npm publish, so their contents are copied into
  place and the vendored tree is identical on every platform.
- **Only markdown below `skills/` is copied**, so the output stays reviewable.

</details>

## Licence and attribution

The vendored skills are redistributed **unmodified** under the Apache License
2.0 from [timescale/pg-aiguide](https://github.com/timescale/pg-aiguide). See
[LICENSE](LICENSE) and [NOTICE](NOTICE); the upstream copyright notice is
retained verbatim as that licence requires.

This plugin configures a connection to a public MCP server operated by Tiger
Data. It vendors no server code and sends no telemetry.

`icon.svg` is Pazalo's logo.

## Layout

```
cordis.patch.yml            the bundle: three independent rows
icon.svg                    the plugin panel's row image
src/catalog.js              reads the vendored skills and their frontmatter
src/entry-skills.js         loader entry registering the skills
src/entry-prompt.js         loader entry publishing the guidance section
src/prompt.js               the guidance text and its visibility check
assets/skills/              the vendored pg-aiguide skills (synced, not edited)
assets/upstream.json        the upstream commit and a digest per file
scripts/sync-upstream.mjs   the vendoring tool
scripts/check-patch.mjs     CI gate: bundle patch, exports and icon
test/plugin.test.js         behaviour tests
```

Never edit anything under `assets/skills/` by hand: the next sync overwrites it
and `sync:check` fails on the difference. Change upstream, or change this
plugin's own source.

<p align="center">
  <sub>Plugin © 2026 dsh-postgres-expert contributors<br>
  Skills © 2025 Timescale, Inc., d/b/a Tiger Data — Apache-2.0</sub>
</p>
