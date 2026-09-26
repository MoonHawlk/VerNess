/** One validation problem: where (a JSON path) and what. */
export interface Issue {
  path: (string | number)[]
  message: string
}

/** A validator's outcome. `value` is the normalised input (defaults applied). */
export type Result<T> = { ok: true, value: T } | { ok: false, errors: Issue[] }

/** Render a path like `tools.allow[2]`. */
export function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((s, p) => (typeof p === 'number' ? `${s}[${p}]` : s === '' ? p : `${s}.${p}`), '')
}

/** Closest candidate by edit distance, for "did you mean". Undefined when nothing is close. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestD = Infinity
  for (const c of candidates) {
    const d = editDistance(word, c)
    if (d < bestD) { bestD = d; best = c }
  }
  return bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return dp[a.length]![b.length]!
}
