import type { Doc } from '@shared/types'
import { JotError } from '@shared/result'

export interface ReadRange { lineStart?: number; lineEnd?: number; columnStart?: number }
export interface ReadPosition { lineStart: number; columnStart: number }
export interface ReadPage {
  text: string
  lineStart: number
  lineEnd: number
  columnStart: number
  next: ReadPosition | null
}
const READ_LIMIT = 6000

export function readPage(doc: Pick<Doc, 'body' | 'bodyStartLine'>, range: ReadRange = {}): ReadPage {
  const requested = range.lineStart ?? 1, column = range.columnStart ?? 1
  if (![requested, column, range.lineEnd ?? requested].every(value => Number.isSafeInteger(value) && value >= 1)
    || range.lineEnd !== undefined && range.lineEnd < requested) throw new JotError('INVALID_INPUT', '读取行列需为正整数，结束行不能早于起始行')
  const lines = doc.body.split('\n'), lineStart = Math.max(requested, doc.bodyStartLine)
  const empty = (): ReadPage => ({ text: '', lineStart, lineEnd: lineStart, columnStart: column, next: null })
  const first = lineStart - doc.bodyStartLine
  if (!doc.body || first >= lines.length || (range.lineEnd ?? Infinity) < lineStart) return empty()
  if (column > lines[first]!.length + 1) throw new JotError('INVALID_INPUT', '起始列超出当前行，请重新读取')
  const last = Math.min(lines.length - 1, (range.lineEnd ?? Infinity) - doc.bodyStartLine)
  const start = lines.slice(0, first).reduce((size, line) => size + line.length + 1, 0) + column - 1
  const bound = lines.slice(0, last + 1).reduce((size, line, index) => size + line.length + (index < lines.length - 1 ? 1 : 0), 0)
  let end = Math.min(start + READ_LIMIT, bound)
  if (end < bound && /[\uD800-\uDBFF]/.test(doc.body.charAt(end - 1))) end--
  const text = doc.body.slice(start, end), pieces = text.split('\n'), newline = text.lastIndexOf('\n')
  const nextLine = lineStart + pieces.length - 1
  const nextColumn = newline < 0 ? column + text.length : text.length - newline
  return { text, lineStart, lineEnd: text.endsWith('\n') ? nextLine - 1 : nextLine, columnStart: column,
    next: end < bound ? { lineStart: nextLine, columnStart: nextColumn } : null }
}
