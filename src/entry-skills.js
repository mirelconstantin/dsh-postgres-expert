/**
 * Loader entry that registers the vendored PostgreSQL skills.
 *
 * One registration per vendored skill, each disposed by its own effect, so
 * unloading this row leaves the registry exactly as it was. The read is
 * synchronous on purpose: `ctx.effect` collects a disposer returned by its body
 * and the awaited disposer when the body returns a promise, and a synchronous
 * registration disposes the same way in the harness as in a hand-mounted test.
 *
 * A vendored body that is missing or unparseable is a packaging error, so it
 * fails the load with the offending path in the message rather than registering
 * a partial catalogue.
 *
 * @module dsh-postgres-expert/entry-skills
 */

import { loadVendoredSkill, readUpstreamPin, vendoredSkillNames } from './catalog.js'

/** Loader identity. */
export const name = 'dsh-postgres-expert-skills'

/** Required services: the skill registry. */
export const inject = ['skills']

/**
 * Register every vendored skill on the harness skill registry.
 *
 * @param {any} ctx - Cordis context providing `skills`.
 * @returns {() => void} a disposer that removes every contribution.
 * @throws {Error} when the skills service is absent or a vendored body is unusable.
 */
export function apply (ctx) {
  const skills = typeof ctx?.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    throw new Error('dsh-postgres-expert: the skills service is not mounted')
  }

  const disposers = []
  for (const skillName of vendoredSkillNames()) {
    const skill = loadVendoredSkill(skillName)
    disposers.push(ctx.effect(() => skills.register({
      name: skill.name,
      description: skill.description,
      // Both surfaces are enabled: the model routes on the description, and a
      // user can invoke a skill by name from the command palette.
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-postgres-expert',
      source: 'bundled',
      content: skill.content,
      path: skill.path,
      resourceBase: skill.resourceBase,
    }), `postgres-guide.skill.${skill.name}`))
  }

  const pin = readUpstreamPin()
  if (pin) {
    log(`registered ${disposers.length} PostgreSQL skills from ${pin.repository}@${pin.commit}`)
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/**
 * Report the catalogue on stderr.
 *
 * The plugin has no logger injection, so this writes directly. A failure to
 * write is not worth failing a load over, which is why the call is guarded.
 *
 * @param {string} message - the line to report.
 * @returns {void} nothing.
 */
function log (message) {
  try {
    process.stderr.write(`[dsh-postgres-expert] ${message}\n`)
  } catch {
    /* stderr is gone; there is nothing left to report this to */
  }
}
