import path from 'node:path'
import type { Classification, DocMeta, DocType } from '@shared/types'
import { localIso } from '../util/time'
import type { ParsedDoc } from './frontmatter'
import { DIRS } from './paths'
import { contentArea } from '@shared/storage'

const DOC_TYPES: readonly DocType[] = ['idea', 'log', 'note', 'file', 'source-summary', 'daily']

export function isMarkdown(rel: string): boolean {
  return /\.(md|markdown)$/i.test(rel)
}

/** 文件头没写类型时，按所在目录推断 */
export function typeFromPath(rel: string): DocType {
  const under = (dir: string) => rel === dir || rel.startsWith(dir + '/')
  if (under(DIRS.ideas)) return 'idea'
  if (under(DIRS.journal)) return 'daily'
  if (under(DIRS.wikiSources)) return 'source-summary'
  return 'note'
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined)
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => str(x)).filter((x): x is string => !!x))] : str(v) ? [str(v)!] : []

/** 想法和记事没有标题，取正文第一行 */
function firstLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim()
    if (t) return [...t].length > 40 ? [...t].slice(0, 40).join('') + '…' : t
  }
  return ''
}

/** 取 [[链接]] 里的目标路径 */
export function wikilinkTarget(v: unknown): string | undefined {
  const s = str(v)
  if (!s) return undefined
  const m = /^\[\[(.+?)(?:\|.*)?\]\]$/.exec(s)
  return (m ? m[1] : s)?.trim()
}

export function classificationOf(data: Record<string, unknown>): Classification {
  return {
    tags: strList(data.tags),
    place: str(data.place),
    people: strList(data.people),
  }
}

export function buildMeta(rel: string, parsed: ParsedDoc, stat: { birthtime: Date; mtime: Date }): DocMeta {
  const data = parsed.data
  const declared = str(data.type) as DocType | undefined
  const type = contentArea(rel) === 'ideas' ? (declared === 'log' ? 'log' : 'idea')
    : declared ? DOC_TYPES.includes(declared) ? declared : 'note' : typeFromPath(rel)
  const base = path.posix.basename(rel).replace(/\.(md|markdown)$/i, '')
  const title = type === 'idea' || type === 'log' ? firstLine(parsed.body) || base : base
  const created = str(data.created) ?? (type === 'daily' && str(data.date) ? `${str(data.date)}T00:00:00` : localIso(stat.birthtime))
  return {
    path: rel,
    type,
    role: type === 'file' ? 'source' : ['idea', 'log'].includes(type) ? 'record' : ['daily', 'source-summary'].includes(type) ? 'derived' : 'note',
    title,
    created,
    modified: localIso(stat.mtime),
    generatedByAi: str(data.generated_by) === 'ai',
    classification: classificationOf(data),
    properties: data,
    invalidProperties: parsed.invalid,
    occurredAt: str(data.occurred_at),
    start: str(data.start),
    end: str(data.end),
    sourcePath: type === 'source-summary' ? wikilinkTarget(data.source) : undefined,
  }
}
