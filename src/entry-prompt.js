/**
 * Loader entry that publishes the PostgreSQL guidance section.
 *
 * @module dsh-postgres-expert/entry-prompt
 */

import { buildSection } from './prompt.js'

/** Loader identity. */
export const name = 'dsh-postgres-expert-prompt'

/** Required services: system-prompt assembly. */
export const inject = ['systemPrompt']

/**
 * Publish the guidance section.
 *
 * The section is a PROVIDER, not a string. A static section would be injected
 * into every assembly, including scopes where a preset's tool restriction or a
 * subagent's `toolFilter` removed the skills — telling the model to load a skill
 * it cannot reach. Evaluated per assembly against the scope it is for, it
 * contributes nothing there and the full text everywhere else.
 *
 * @param {any} ctx - Cordis context providing `systemPrompt`.
 * @returns {() => void} the section disposer.
 */
export function apply (ctx) {
  const reference = typeof ctx.systemPrompt.getSectionOrder === 'function'
    ? ctx.systemPrompt.getSectionOrder('TOOL_WEB_FETCH')
    : 2150
  return ctx.systemPrompt.section({
    name: 'postgres-guide',
    // Just after the plain web-fetch guidance, so the model reads "the manual is
    // searchable here" alongside "there is a fetcher for the web".
    order: Number.isFinite(reference) ? reference + 15 : 2165,
    // Literal text: the section mentions tool names and backticks that must not
    // be treated as prompt variables.
    interpolate: false,
    text: context => buildSection(ctx, context?.scope),
  })
}
