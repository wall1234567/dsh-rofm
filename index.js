/**
 * dsh-rofm — host plugin entry.
 *
 * Host-only logic, plus a browser half (`client.js`, declared through
 * `package.json` `dsh.client`) that shows the Derpyu whitelist consent prompt.
 * The host half has no commands, no timers and no child processes; the browser
 * half only polls the host's consent route while the prompt matters. It
 * contributes **4 model tools** (`memory_judge` / `memory_recall` /
 * `memory_image` / `memory_group_recall`), **3 system-prompt sections**
 * (`dsh-rofm:recall`, `dsh-rofm:memory-tasks` and `dsh-rofm:memory-rules`) and
 * **3 event listeners** (`agent/inbox/inserted` / `agent/pre-step` /
 * `agent/disposed`; a 4th `session/event` listener is added only when QQ channel
 * compatibility is active). `memory_group_recall` (v1.4.2) is registered only when QQ compat is
 * active: it lets an owner private chat read group memories read-only.
 * Cordis disposes all of them when the plugin row is disabled, so a disabled
 * plugin cannot keep working in the background.
 *
 * `enabled:false` in `config.json` is different from disabling the row: the
 * plugin stays loaded, but `start()` returns before registering anything (no
 * tools, sections, listeners, compat detection or auto-patch). Because that
 * decision is made once at activation, changing `enabled` back to `true`
 * requires reloading the plugin row / restarting DSH — see README §5.
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
