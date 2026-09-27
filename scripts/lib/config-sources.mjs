/**
 * Source attribution for `/config`: for each resolved value, the layer that owns it — a built-in
 * default, `verness.config.json`, `.verness/state.json`, a persona file, or the environment.
 *
 * Pure functions over already-loaded data, so they need neither the launcher (which cannot be
 * imported from a command while its REPL runs) nor its `DEFAULTS`: the config is merged per
 * `section.field`, so a field present in the parsed file is owned by the file and any other field
 * is a default.
 * @module scripts/lib/config-sources
 */

export const SOURCE = {
  default: 'built-in default',
  file: 'verness.config.json',
  state: '.verness/state.json',
  env: 'environment',
}

/** Key names that hold credentials. `...Env` keys name a variable, not a secret, and stay visible. */
const SECRET_KEY = /(api_?key|token|secret|password|passwd|credential|bearer|private_?key|auth)/i
/** Values shaped like a provider key, masked whatever the key is called. */
const SECRET_VALUE = /^(sk-|sk_|pk_|rk_|ghp_|gho_|github_pat_|glpat-|xox[abpr]-|hf_|AIza)[A-Za-z0-9_-]{12,}/

/**
 * @param {string} key - a config key name.
 * @returns {boolean} whether a string under this key is a credential.
 */
export const isSecretKey = key => SECRET_KEY.test(key) && !/env$/i.test(key)

/**
 * Replace every credential in a value, however deeply nested, with a placeholder. Numbers and
 * booleans are never masked (`maxTokens` is a limit, not a token).
 * @param {unknown} value - the value to clean.
 * @param {string} [key] - the key the value sits under.
 * @returns {unknown} a copy with secrets masked.
 */
export function maskSecrets(value, key = '') {
  if (typeof value === 'string') return value !== '' && (isSecretKey(key) || SECRET_VALUE.test(value)) ? '******** (hidden)' : value
  if (Array.isArray(value)) return value.map(v => maskSecrets(v, key))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecrets(v, k)]))
  }
  return value
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const has = (o, k) => isObject(o) && Object.hasOwn(o, k)

/**
 * The owner of one `section.field` (or top-level `key`) of the merged config.
 * @param {object|undefined} raw - the parsed `verness.config.json`, or `undefined` when absent.
 * @param {string} section - the top-level key.
 * @param {string} [field] - the field inside it.
 * @returns {string} a `SOURCE` label.
 */
export function fileOrDefault(raw, section, field) {
  if (field === undefined) return has(raw, section) ? SOURCE.file : SOURCE.default
  return has(raw?.[section], field) ? SOURCE.file : SOURCE.default
}

/**
 * Every setting of the merged config, one row per `section.field`, with its owner.
 * @param {object} cfg - the merged configuration (defaults + file).
 * @param {object|undefined} raw - the parsed `verness.config.json`.
 * @returns {{key: string, value: unknown, source: string}[]} rows, values masked.
 */
export function settingRows(cfg, raw) {
  const rows = []
  const keys = [...new Set([...Object.keys(cfg), ...Object.keys(isObject(raw) ? raw : {})])]
  for (const k of keys) {
    const v = cfg[k] ?? raw?.[k]
    if (isObject(v) && Object.keys(v).length > 0) {
      for (const [f, fv] of Object.entries(v)) rows.push({ key: `${k}.${f}`, value: maskSecrets(fv, f), source: fileOrDefault(raw, k, f) })
    } else {
      rows.push({ key: k, value: maskSecrets(v, k), source: fileOrDefault(raw, k) })
    }
  }
  return rows
}

/**
 * The values the next task actually runs with, after state and persona overrides, with the layer
 * that decided each one.
 * @param {object} input - everything already resolved by the caller.
 * @param {object} input.cfg - the merged configuration.
 * @param {object|undefined} input.raw - the parsed `verness.config.json`.
 * @param {object} input.state - the parsed `.verness/state.json` (`{}` when absent).
 * @param {{id: string, source: string, model?: object}|undefined} input.persona - the active persona.
 * @param {{name: string, route?: object, model?: string, source: string}} input.effective - the
 *   `effectiveRoute(cfg)` result.
 * @param {string} input.access - the effective access mode.
 * @param {string|undefined} input.accessEnv - `DSH_PERMISSION_MODE`, when set.
 * @returns {{key: string, value: unknown, source: string}[]} rows, values masked.
 */
export function resolvedRows({ cfg, raw, state, persona, effective, access, accessEnv }) {
  const personaLabel = persona === undefined ? SOURCE.default
    : persona.source === SOURCE.file ? `${SOURCE.file} (personas.definitions.${persona.id})` : `persona file ${persona.source}`
  const rows = []

  rows.push({
    key: 'persona',
    value: persona?.id ?? state.persona ?? cfg.personas?.active,
    source: state.persona !== undefined ? SOURCE.state : fileOrDefault(raw, 'personas', 'active'),
  })

  const configured = cfg.activeRoute === '' || cfg.activeRoute === undefined
    ? fileOrDefault(raw, 'model', 'route')
    : fileOrDefault(raw, 'activeRoute')
  rows.push({
    key: 'route',
    value: effective.name,
    source: state.route !== undefined ? SOURCE.state : persona?.model?.route !== undefined ? personaLabel : configured,
  })

  // Which layer declared the route itself decides who owns its default model.
  const routeOwner = effective.name === cfg.model?.route ? fileOrDefault(raw, 'model', 'id')
    : has(cfg.extraRoutes, effective.name) ? SOURCE.file
      : has(state.apiRoutes, effective.name) ? SOURCE.state : SOURCE.default
  rows.push({
    key: 'model',
    value: effective.model ?? '(none)',
    source: effective.source === '/model override' ? SOURCE.state
      : effective.source.startsWith('persona ') ? personaLabel
        : effective.source === 'none' ? '(unresolved)' : routeOwner,
  })

  rows.push({ key: 'access', value: access, source: accessEnv !== undefined ? `${SOURCE.env} (DSH_PERMISSION_MODE)` : state.access !== undefined ? SOURCE.state : SOURCE.default })
  rows.push({ key: 'session', value: state.session ?? '(new)', source: state.session !== undefined ? SOURCE.state : SOURCE.default })

  // Anything else the state holds is launcher-owned too: `/api use` routes, `/models add` models.
  const shown = new Set(['persona', 'route', 'model', 'modelRoute', 'access', 'session'])
  for (const [k, v] of Object.entries(state)) {
    if (!shown.has(k) && v !== undefined) rows.push({ key: `state.${k}`, value: maskSecrets(v, k), source: SOURCE.state })
  }
  return rows
}

/**
 * One value as a short display string: strings as typed, small structures as JSON, large ones by
 * their size or keys.
 * @param {unknown} v - the (already masked) value.
 * @param {number} [width] - the longest string to print before summarizing.
 * @returns {string} the display form.
 */
export function formatValue(v, width = 60) {
  if (v === undefined) return '(unset)'
  if (typeof v === 'string') return v.length > width ? `${v.slice(0, width - 1)}…` : v === '' ? '""' : v
  const json = JSON.stringify(v)
  if (json.length <= width) return json
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`
  const keys = Object.keys(v)
  const list = keys.join(', ')
  return `{ ${list.length > width - 6 ? `${keys.length} keys` : list} }`
}
