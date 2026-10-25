/**
 * dsh-rofm — host plugin entry.
 *
 * Pure Host plugin: no Client half, no tools, no commands, no timers and no
 * child processes. It contributes one system-prompt section and three event
 * listeners (inbox / pre-step / disposed); Cordis disposes all of them when the
 * plugin row is disabled, so a disabled plugin cannot keep working in the
 * background.
 */

import { RofmPlugin } from './lib/plugin.js'

export const name = 'dsh-rofm'

// Deliberately no hard `inject` list: services are looked up defensively inside
// the plugin (see RofmPlugin.start) so a Harness version without e.g.
// tokenMeter still activates and supports the features it can.

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config bundle-row config (optional)
 */
export function apply(ctx, config) {
  const plugin = new RofmPlugin(ctx, config ?? {})
  plugin.start()
  return plugin
}
