/**
 * Type declarations for `util.mjs`, so TypeScript code (the contracts tests) can import the
 * launcher's shared primitives. Keep in step with the JSDoc there.
 * @module scripts/lib/util
 */

type ShOptions = { capture?: boolean, env?: Record<string, string>, cwd?: string }
type ShResult = { code: number, out: string }
type Colour = 'dim' | 'red' | 'green' | 'yellow' | 'cyan' | 'bold' | 'off'

export const REPO: string
export const WIN: boolean
export const RUN_DIR: string

export function paint(name: Colour, s: string): string
export function head(s: string): void
export function step(s: string): void
export function ok(s: string): void
export function warn(s: string): void
export function info(s: string): void
export function line(s: string): void

export function parseJsonc(text: string): any
export function winQuote(a: string): string
export function sh(cmd: string, args: string[], opts?: ShOptions): ShResult
export function spawnAsync(file: string, args: string[], opts?: ShOptions & { shell?: boolean }): Promise<ShResult>
export function shAsync(cmd: string, args: string[], opts?: ShOptions): Promise<ShResult>
export function hiddenStartCommand(file: string, args: string[], errFile?: string): string
export function startBackground(file: string, args: string[], opts?: { env?: Record<string, string>, cwd?: string, errFile?: string }): { pid?: number, error?: string }
export function human(bytes: number): string
export function num(n: number): string
export function table(headers: string[], rows: (string | number)[][]): string[]
