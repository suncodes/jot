import { mappedPath } from '@shared/files'
import path from 'node:path'
import type { FileLink, PathChange } from '@shared/files'
import { isInMeta, normalizeRel } from './paths'

export interface LinkSpan {
  start: number
  end: number
  target: string
  kind: 'markdown' | 'wiki'
}
const lower = (value: string) => value.toLocaleLowerCase()
const blank = (value: string) => value.replace(/[^\r\n]/g, ' ')

/** 保留字符位置，排除代码、注释及转义链接，避免改动示例。 */
function visibleText(text: string): string {
  const lines = text.split(/(?<=\n)/)
  let fence: { marker: string; width: number } | undefined
  const result = lines.map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.width && !line.slice(match[0].length).trim()) fence = undefined
      return blank(line)
    }
    if (match) { fence = { marker: match[1]![0]!, width: match[1]!.length }; return blank(line) }
    if (/^(?: {4}|\t)/.test(line)) return blank(line)
    return line
  }).join('')
  return result.replace(/<!--[\s\S]*?(?:-->|$)/g, blank).replace(/(`+)([\s\S]*?)\1(?!`)/g, blank).replace(/\\[\[\]]/g, blank)
}

export function scanLinks(text: string): LinkSpan[] {
  const visible = visibleText(text)
  const spans: LinkSpan[] = []
  for (const match of visible.matchAll(/\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    const raw = match[1]!
    const leading = raw.length - raw.trimStart().length
    const start = match.index! + 2 + leading
    spans.push({ start, end: start + raw.trim().length, target: raw.trim(), kind: 'wiki' })
  }
  const addDestination = (start: number): void => {
    let end = start
    if (visible[start] === '<') {
      start++
      end = visible.indexOf('>', start)
      if (end < 0) return
    } else {
      let depth = 0
      while (end < visible.length) {
        const char = visible[end]!
        if (char === '\\') { end += 2; continue }
        if (char === '(') depth++
        if (char === ')') { if (!depth) break; depth-- }
        if (/\s/.test(char) && !depth) break
        end++
      }
    }
    const target = text.slice(start, end)
    if (target) spans.push({ start, end, target, kind: 'markdown' })
  }
  for (const match of visible.matchAll(/!?\[[^\]\n]*\]\(\s*/g)) addDestination(match.index! + match[0].length)
  for (const match of visible.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*/gm)) addDestination(match.index! + match[0].length)
  return spans.sort((a, b) => a.start - b.start)
}

function targetParts(raw: string): { target: string; suffix: string } | null {
  const offset = raw.search(/[?#]/)
  const target = offset < 0 ? raw : raw.slice(0, offset)
  if (!target || /^[a-z][a-z\d+.-]*:|^[/\\]/i.test(target)) return null
  try {
    const decoded = decodeURIComponent(target).replace(/\\([()[\] ])/g, '$1').replace(/\\/g, '/')
    if (/^[a-z][a-z\d+.-]*:|^\//i.test(decoded)) return null
    return { target: decoded, suffix: offset < 0 ? '' : raw.slice(offset) }
  } catch { return null }
}

/** 普通链接相对当前文件，双链的完整路径相对库根，单名双链仅在唯一时解析。 */
export function resolveTarget(from: string, raw: string, kind: FileLink['kind'], paths: string[]): { path?: string; ambiguous?: string[] } {
  const parts = targetParts(raw)
  if (!parts) return {}
  const target = normalizeRel(kind === 'markdown' ? path.posix.join(path.posix.dirname(from), parts.target) : parts.target)
  if (target === '..' || target.startsWith('../') || isInMeta(target)) return {}
  const exact = paths.filter(candidate => lower(candidate) === lower(target))
  if (exact.length === 1) return { path: exact[0] }
  if (kind !== 'wiki') return {}
  const stripped = (value: string) => lower(value.replace(/\.(md|markdown)$/i, ''))
  const matches = paths.filter(candidate => stripped(candidate) === stripped(target))
  const candidates = matches.length || parts.target.includes('/') ? matches
    : paths.filter(candidate => stripped(path.posix.basename(candidate)) === stripped(parts.target))
  return candidates.length === 1 ? { path: candidates[0] } : candidates.length > 1 ? { ambiguous: candidates } : {}
}


export function intendedTarget(from: string, raw: string, kind: FileLink['kind']): string | undefined {
  const parts = targetParts(raw)
  if (!parts) return undefined
  const rel = path.posix.normalize(kind === 'markdown' ? path.posix.join(path.posix.dirname(from), parts.target) : parts.target)
  return rel === '..' || rel.startsWith('../') || rel.startsWith('/') || isInMeta(rel) ? undefined : rel
}

export { mappedPath } from '@shared/files'

export function rewriteLinks(body: string, from: string, to: string, changes: PathChange[], oldPaths: string[]): string {
  let rewritten = body
  for (const span of scanLinks(body).reverse()) {
    const parts = targetParts(span.target)
    if (!parts) continue
    const resolved = resolveTarget(from, span.target, span.kind, oldPaths).path
    // 明确路径的断链也可以在文件自身移动时重算；单名歧义双链不猜目标。
    const oldTarget = resolved ?? (span.kind === 'markdown' ? path.posix.normalize(path.posix.join(path.posix.dirname(from), parts.target)) : undefined)
    if (!oldTarget || oldTarget.startsWith('../') || isInMeta(oldTarget)) continue
    const destination = mappedPath(oldTarget, changes)
    if (destination === oldTarget && (from === to || span.kind === 'wiki')) continue
    let value = span.kind === 'markdown' ? path.posix.relative(path.posix.dirname(to), destination) : destination
    if (span.kind === 'wiki' && !/\.(md|markdown)$/i.test(parts.target)) value = value.replace(/\.(md|markdown)$/i, '')
    if (value === parts.target) continue
    if (span.kind === 'markdown') value = encodeURI(value).replace(/[?#()[\]]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
    rewritten = rewritten.slice(0, span.start) + value + parts.suffix + rewritten.slice(span.end)
  }
  return rewritten
}
