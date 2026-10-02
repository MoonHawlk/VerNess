/**
 * The Node version the substrate needs, in one dependency-free module. `scripts/cli.mjs` imports it
 * before anything that pulls in `.ts` files (which an old Node cannot even link), so it must stay
 * free of imports and of syntax newer than ES2020.
 * @module scripts/lib/node-version
 */

/** Lowest supported 22.x release; any 24+ is fine, 23 is not (`package.json` engines). */
export const NODE_MIN = [22, 19, 0]

/**
 * @param {string} [version] - a Node version such as `22.19.0` (default: the running one).
 * @returns {boolean} whether it satisfies `^22.19.0 || >=24.0.0`.
 */
export function nodeOk(version = process.versions.node) {
  const [maj, min, pat] = String(version).replace(/^v/, '').split('.').map(Number)
  if (maj >= 24) return true
  return maj === NODE_MIN[0] && (min > NODE_MIN[1] || (min === NODE_MIN[1] && pat >= NODE_MIN[2]))
}
