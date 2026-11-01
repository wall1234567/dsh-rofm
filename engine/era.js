/**
 * dsh-rofm engine — memory-data era classification (v1.4.0, docs/SPEC.md §4.1).
 *
 * The installed memory store mixes three very different generations of data.
 * Treating them as one backlog produced the misleading "81.8% pending" number:
 *
 *   legacy     — pre-1.2.0 data. The early plugin listed only 6+6 / 12+12 folders
 *                and never told the model "you must score this turn", so whole
 *                sessions were archived without ever being scored. Not re-scored
 *                in 1.4.0 (it is historical debris, not a current defect).
 *   synthetic  — 1.2-1.3 pressure tests. A fake/tiny context window (8k/2k/400k)
 *                plus 500-folders-per-pass archiving produced stress-level
 *                backlogs. Not a normal-behaviour sample.
 *   current    — everything archived by a normal session with a real window.
 *                This is the only bucket whose pending share is an actual signal.
 *
 * The rules are centralised here (one truth) because four different consumers
 * must agree on the numbers: `lib/plugin.js` (task block filtering),
 * `tools/memory-audit.mjs`, `tools/selfcheck.mjs` and `tools/recall-report.mjs`.
 *
 * Zero dependencies, pure functions, no Date.now() (callers pass what they need).
 */

/**
 * v1.2.0 tag = 2026-10-28 03:14 (+08) = 2026-10-27T19:14:00Z. Folders archived
 * before it are pre-1.2.0 "legacy" data.
 */
export const LEGACY_ERA_CUTOFF_MS = Date.parse('2026-10-27T19:14:00Z')

/** A window below this token count is a fake/tiny pressure-test window. */
export const SYNTHETIC_WINDOW_TOKENS = 32000

/** A `beforePercent` above this means the recorded context exceeded the window. */
export const SYNTHETIC_BEFORE_PERCENT = 500

/**
 * A fake window alone is not enough to call a session synthetic: the 1.3.0 QQ
 * channel test also ran on a 2000-token window but archived only 10 folders and
 * left 2 pending — that is channel behaviour, not a pressure test. A synthetic
 * session must additionally show stress-level volume (plan §2.2: a46df597 has
 * 2780 folders / 2180 pending; qqb-g-1134030529 has 10 folders / 2 pending).
 */
export const STRESS_MIN_FOLDERS = 100
export const STRESS_MIN_PENDING = 100

const ERA_LEGACY = 'legacy'
const ERA_CURRENT = 'current'
const ERA_SYNTHETIC = 'synthetic'

/** Telemetry event types that carry the recorded window size. */
const WINDOW_EVENT_TYPES = new Set(['compress', 'compress-applied', 'archive'])

/**
 * Derive the session-level "did this session run on a fake window" signals from
 * the session's own `stats.jsonl` events.
 *
 * @param {Array<object>} events parsed stats.jsonl lines (readStats output)
 * @returns {{ fakeWindow: boolean, tinyWindow: boolean, overWindow: boolean,
 *   windowTokens: number|null, maxBeforePercent: number|null }}
 */
export function sessionEraSignals(events) {
  const list = Array.isArray(events) ? events : []
  let windowTokens = null
  let maxBeforePercent = null
  let tinyWindow = false
  let overWindow = false
  for (const event of list) {
    if (!event || typeof event !== 'object') continue
    if (typeof event.type === 'string' && !WINDOW_EVENT_TYPES.has(event.type)) continue
    const tokens = Number(event.windowTokens)
    const before = Number(event.beforePercent)
    if (Number.isFinite(tokens) && tokens > 0) {
      if (windowTokens === null || tokens < windowTokens) windowTokens = tokens
      if (tokens < SYNTHETIC_WINDOW_TOKENS) tinyWindow = true
    }
    if (Number.isFinite(before)) {
      if (maxBeforePercent === null || before > maxBeforePercent) maxBeforePercent = before
      if (before > SYNTHETIC_BEFORE_PERCENT) overWindow = true
    }
  }
  return {
    fakeWindow: tinyWindow || overWindow,
    tinyWindow,
    overWindow,
    windowTokens,
    maxBeforePercent,
  }
}

/**
 * Session-level era. Only `synthetic` and `current` are decided here; `legacy`
 * is a per-folder property (a single session can contain legacy folders and
 * current folders after an upgrade).
 *
 * @param {{ folders?: number, pending?: number, signals?: ReturnType<typeof sessionEraSignals> }} input
 * @returns {{ era: 'synthetic'|'current', reasons: object }}
 */
export function sessionEra(input = {}) {
  const opts = input && typeof input === 'object' ? input : {}
  const signals = opts.signals && typeof opts.signals === 'object' ? opts.signals : sessionEraSignals([])
  const folders = Number.isFinite(opts.folders) ? opts.folders : 0
  const pending = Number.isFinite(opts.pending) ? opts.pending : 0
  const stressBacklog = folders >= STRESS_MIN_FOLDERS || pending >= STRESS_MIN_PENDING
  const era = signals.fakeWindow === true && stressBacklog ? ERA_SYNTHETIC : ERA_CURRENT
  return {
    era,
    reasons: {
      fakeWindow: signals.fakeWindow === true,
      tinyWindow: signals.tinyWindow === true,
      overWindow: signals.overWindow === true,
      windowTokens: signals.windowTokens ?? null,
      maxBeforePercent: signals.maxBeforePercent ?? null,
      folders,
      pending,
      stressBacklog,
    },
  }
}

/**
 * Era of one folder. An explicit `pendingEra` marker (written by
 * `tools/memory-audit.mjs --apply`) always wins; otherwise the v1.2.0 createdAt
 * boundary decides legacy, and the session-level era decides the rest.
 *
 * @param {{ createdAt?: number, pendingEra?: string }|null|undefined} folder
 * @param {{ era?: string }|null} [session]
 * @returns {'legacy'|'current'|'synthetic'}
 */
export function classifyFolderEra(folder, session) {
  const source = folder && typeof folder === 'object' ? folder : {}
  const marked = source.pendingEra
  if (marked === ERA_LEGACY || marked === ERA_CURRENT || marked === ERA_SYNTHETIC) return marked
  const createdAt = Number(source.createdAt)
  if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < LEGACY_ERA_CUTOFF_MS) return ERA_LEGACY
  return session && session.era === ERA_SYNTHETIC ? ERA_SYNTHETIC : ERA_CURRENT
}

/**
 * Aggregate the three era buckets over one store's index entries.
 *
 * @param {Array<{createdAt?: number, pendingEra?: string, scored?: boolean}>} folders
 * @param {{ era?: string }|null} [session]
 * @returns {{
 *   total: number, folders: object, scored: object, pending: object,
 *   pendingPercent: number|null, currentPendingPercent: number|null, pendingFolders: Array<string>,
 * }}
 */
export function summarizeEras(folders, session) {
  const buckets = {
    legacy: { folders: 0, scored: 0, pending: 0 },
    current: { folders: 0, scored: 0, pending: 0 },
    synthetic: { folders: 0, scored: 0, pending: 0 },
  }
  let total = 0
  const currentPending = []
  for (const folder of Array.isArray(folders) ? folders : []) {
    if (!folder || typeof folder.id !== 'string') continue
    const era = classifyFolderEra(folder, session)
    const bucket = buckets[era]
    total += 1
    bucket.folders += 1
    if (folder.scored === false) bucket.pending += 1
    else bucket.scored += 1
    if (era === ERA_CURRENT && folder.scored === false) currentPending.push(folder.id)
  }
  const pendingTotal = buckets.legacy.pending + buckets.current.pending + buckets.synthetic.pending
  const currentTotal = buckets.current.folders
  const pendingPercent = total > 0 ? round((pendingTotal / total) * 100, 2) : null
  const currentPendingPercent = currentTotal > 0 ? round((buckets.current.pending / currentTotal) * 100, 2) : null
  return {
    total,
    folders: { legacy: buckets.legacy.folders, current: buckets.current.folders, synthetic: buckets.synthetic.folders },
    scored: { legacy: buckets.legacy.scored, current: buckets.current.scored, synthetic: buckets.synthetic.scored },
    pending: { legacy: buckets.legacy.pending, current: buckets.current.pending, synthetic: buckets.synthetic.pending },
    pendingPercent,
    currentPendingPercent,
    pendingFolders: currentPending,
  }
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}
