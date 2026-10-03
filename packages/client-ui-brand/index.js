/**
 * Node half of the FiNess browser brand: an empty Loader seat. The substrate's client-module table
 * only scans plugins its host Loader has loaded, so the row needs a node entry; everything visible
 * lives in `client.js` (the browser half, declared by `dsh.client` in package.json).
 * @module @finess/client-ui-brand
 */

export const name = 'finess-client-ui-brand'

/** Nothing to do on the host. */
export function apply() {}
