/** A 1-based line/column position, columns counted in UTF-16 code units. */
export interface Position {
  line: number
  column: number
}

interface Frame {
  type: 'object' | 'array'
  path: (string | number)[]
  openPos: Position
  index: number
}

/**
 * Find where a JSON path resolves to in raw JSONC text (comments and trailing
 * commas tolerated), returning a 1-based `{line, column}`.
 *
 * Points at the value for a path that exists. When the last segment of the
 * path is a missing object key or an out-of-range array index, points at the
 * enclosing container's opening bracket instead. Returns `undefined` when an
 * earlier (non-last) segment is missing, when a segment indexes into a
 * scalar, or when the text itself is not a JSON container and a non-empty
 * path was requested.
 */
export function locate(text: string, path: (string | number)[]): Position | undefined {
  const len = text.length
  let i = 0
  let line = 1
  let column = 1

  const posAt = (): Position => ({ line, column })
  const advance = (): void => {
    if (text[i] === '\n') { line++; column = 1 } else { column++ }
    i++
  }
  const skipTrivia = (): void => {
    for (;;) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue }
      if (c === '/' && text[i + 1] === '/') { while (i < len && text[i] !== '\n') advance(); continue }
      if (c === '/' && text[i + 1] === '*') {
        advance(); advance()
        while (i < len && !(text[i] === '*' && text[i + 1] === '/')) advance()
        if (i < len) { advance(); advance() }
        continue
      }
      return
    }
  }
  const readString = (): string => {
    const start = i
    advance()
    while (i < len && text[i] !== '"') {
      if (text[i] === '\\') advance()
      advance()
    }
    if (i < len) advance()
    return text.slice(start, i)
  }
  const skipScalar = (): void => {
    while (i < len) {
      const c = text[i]
      if (c === ',' || c === '}' || c === ']' || c === ' ' || c === '\t' || c === '\r' || c === '\n') break
      if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) break
      advance()
    }
  }
  const samePath = (a: (string | number)[], b: (string | number)[]): boolean =>
    a.length === b.length && a.every((seg, idx) => seg === b[idx])
  const isMissingSegmentOf = (framePath: (string | number)[]): boolean =>
    path.length === framePath.length + 1 && samePath(framePath, path.slice(0, framePath.length))

  skipTrivia()
  if (i >= len) return undefined

  const rootPos = posAt()
  if (path.length === 0) return rootPos

  const rootChar = text[i]
  if (rootChar !== '{' && rootChar !== '[') return undefined

  const stack: Frame[] = []
  const pushFrame = (type: 'object' | 'array', framePath: (string | number)[]): void => {
    stack.push({ type, path: framePath, openPos: posAt(), index: 0 })
    advance()
  }
  pushFrame(rootChar === '{' ? 'object' : 'array', [])

  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame
    skipTrivia()
    const c = text[i]
    if (c === undefined) return undefined

    if (frame.type === 'object' && c === '}') {
      if (isMissingSegmentOf(frame.path)) return frame.openPos
      advance()
      stack.pop()
      continue
    }
    if (frame.type === 'array' && c === ']') {
      if (isMissingSegmentOf(frame.path)) return frame.openPos
      advance()
      stack.pop()
      continue
    }
    if (c === ',') { advance(); continue }

    let childPath: (string | number)[]
    if (frame.type === 'object') {
      if (c !== '"') return undefined
      const raw = readString()
      let key: string
      try {
        key = JSON.parse(raw) as string
      } catch {
        return undefined
      }
      skipTrivia()
      if (text[i] !== ':') return undefined
      advance()
      skipTrivia()
      childPath = [...frame.path, key]
    } else {
      childPath = [...frame.path, frame.index]
      frame.index++
    }

    const valuePos = posAt()
    if (samePath(childPath, path)) return valuePos

    const vc = text[i]
    if (vc === '{' || vc === '[') {
      pushFrame(vc === '{' ? 'object' : 'array', childPath)
    } else if (vc === '"') {
      readString()
    } else {
      skipScalar()
    }
  }
  return undefined
}
