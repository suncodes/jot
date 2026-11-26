import fs from 'node:fs'
import type { DirectoryItem } from '@shared/files'
import type { VaultService } from '../vault/vault'
import { matchesDateRange, matchesTime } from './time'
import path from 'node:path'
import { JotError } from '@shared/result'
import { contentArea, type ContentRole, type ContentScope } from '@shared/storage'
import type { DocMeta, LibraryFacets, LibraryItem, LibraryQuery, LibrarySource, Paged, SearchFilter, SearchHit } from '@shared/types'
import type { ContentQueries, IndexService, SearchQuery } from '../index/index'
import { expandWeighted, makeSnippet } from '../index/index'
import { activityDay, localDay, optionalActivityTime } from '../util/time'
import { isInUserContent, normalizeRel } from '../vault/paths'

interface ContentObject {
  role: ContentRole; meta: DocMeta
  paths: string[]; summary?: string; file?: LibrarySource
}
const lower = (value: string) => value.toLocaleLowerCase()
const under = (rel: string, dir: string) => lower(rel).startsWith(lower(dir) + '/')
const same = (a: string, b: string) => lower(a) === lower(b)
const page = <T>(items: T[], q: { offset?: number; limit?: number }): Paged<T> => ({ total: items.length, items: items.slice(q.offset ?? 0, (q.offset ?? 0) + Math.min(Math.max(q.limit ?? 30, 1), 200)) })

/** 当前路径和 source 配对 → 物理范围／处理集合 → 筛选和分页。 */
export class ContentService implements ContentQueries {
  constructor(private readonly vault: VaultService, private readonly index: IndexService,
    private readonly files: () => LibrarySource[], private readonly suggestionPaths: () => string[] = () => []) {}

  private objects(): ContentObject[] {
    const docs = this.index.allDocs()
    const byPath = new Map(docs.map(doc => [lower(doc.path), doc]))
    const catalog = new Map(this.files().map(file => [lower(file.path), file]))
    const pairs = new Map<string, DocMeta[]>()
    for (const doc of docs) if (doc.type === 'source-summary' && doc.sourcePath && byPath.has(lower(doc.sourcePath))) {
      const key = lower(doc.sourcePath)
      pairs.set(key, [...(pairs.get(key) ?? []), doc])
    }
    const out: ContentObject[] = []
    for (const doc of docs) {
      if (doc.type === 'source-summary' && doc.sourcePath && byPath.has(lower(doc.sourcePath))) continue
      const role = doc.type === 'file' ? 'source' : ['idea', 'log'].includes(doc.type) ? 'record' : ['daily', 'source-summary'].includes(doc.type) ? 'derived' : 'note'
      const summaries = pairs.get(lower(doc.path)) ?? []
      const original = catalog.get(lower(doc.path))
      const file = role === 'source' ? { ...original, path: doc.path, size: doc.size ?? original?.size ?? 0,
        addedAt: doc.created, modified: doc.modified, missing: false,
        state: original?.state ?? (summaries.length ? 'done' as const : /\.(md|markdown|txt|log|csv|json|ya?ml|xml|ini|conf|tsv)$/i.test(doc.path) ? 'unprocessed' as const : 'unsupported' as const),
        text: original?.text ?? /\.(md|markdown|txt|log|csv|json|ya?ml|xml|ini|conf|tsv)$/i.test(doc.path),
        classification: doc.classification, summaryPath: summaries[0]?.path } : undefined
      out.push({ role, meta: { ...doc, role },
        paths: [doc.path, ...summaries.map(summary => summary.path)], summary: summaries[0]?.path ?? (doc.type === 'source-summary' ? doc.path : undefined), file })
    }
    return out
  }

  private directory(rel: string): string {
    if (!isInUserContent(rel)) throw new JotError('PATH_OUTSIDE_VAULT', '目录范围只能位于 content、ideas 或 inbox 内')
    const absolute = this.vault.abs(rel)
    rel = normalizeRel(rel)
    const parts = rel.split('/')
    if (parts.some(part => part.startsWith('.'))) throw new JotError('PATH_OUTSIDE_VAULT', '不能查询隐藏目录')
    for (let i = 1; i <= parts.length; i++) {
      if (fs.lstatSync(this.vault.abs(parts.slice(0, i).join('/')), { throwIfNoEntry: false })?.isSymbolicLink()) throw new JotError('PATH_OUTSIDE_VAULT', '不能查询符号链接目录')
    }
    const stat = fs.statSync(absolute, { throwIfNoEntry: false })
    if (!stat?.isDirectory()) throw new JotError('NOT_FOUND', '目录已不存在')
    return rel
  }

  directories(parent = 'content', recursive = false): DirectoryItem[] {
    const dir = this.directory(parent)
    const out: DirectoryItem[] = []
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(this.vault.abs(rel), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
        const child = rel + '/' + entry.name
        const hasChildren = fs.readdirSync(this.vault.abs(child), { withFileTypes: true }).some(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
        out.push({ path: child, name: entry.name, hasChildren })
        if (recursive) walk(child)
      }
    }
    walk(dir)
    return out.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
  }

  private select(objects: ContentObject[], scope: ContentScope): ContentObject[] {
    let selected: ContentObject[]
    if (scope.selection.kind === 'collection') {
      const name = scope.selection.name
      const pending = new Set(name === 'pending' ? this.suggestionPaths().map(lower) : [])
      selected = objects.filter(o => name === 'ideas' ? contentArea(o.meta.path) === 'ideas'
        : name === 'pending' ? contentArea(o.meta.path) === 'inbox' || pending.has(lower(o.meta.path))
        : contentArea(o.meta.path) !== null || o.meta.type === 'source-summary')
    } else {
      const dir = this.directory(scope.selection.path)
      const recursive = scope.selection.recursive
      const physical = objects.filter(o => (recursive ? under(o.meta.path, dir) : same(path.posix.dirname(o.meta.path), dir)))
      selected = physical
    }
    if (scope.roles?.length) selected = selected.filter(o => scope.roles!.includes(o.role))
    if (scope.time) {
      selected = selected.filter(o => matchesTime(o.meta, scope.time!))
    }
    return selected
  }

  private materialIds(objects: ContentObject[], materials: NonNullable<SearchFilter['materials']>): Set<string> {
    const ids = new Set<string>()
    for (const material of materials) {
      if (material.kind === 'folder' && isInUserContent(material.value)) {
        for (const o of this.select(objects, { selection: { kind: 'directory', path: material.value, recursive: true } })) ids.add(o.meta.path)
      } else {
        for (const o of objects) if (material.kind === 'file'
          ? o.paths.some(p => same(p, material.value))
          : o.paths.some(p => under(p, material.value))) ids.add(o.meta.path)
      }
    }
    return ids
  }

  private matches(o: ContentObject, f: SearchFilter): boolean {
    const c = o.meta.classification
    if (f.types?.length && !f.types.includes(o.meta.type) && !o.paths.some(p => { const doc = this.index.getDoc(p); return !!doc && f.types!.includes(doc.type) })) return false
    for (const key of ['place'] as const) if (f[key] !== undefined && f[key] !== (c[key] ?? '')) return false
    if (f.tags?.some(t => !c.tags.some(tag => tag === t || tag.startsWith(t + '/')))) return false
    if (f.people?.some(p => !c.people.includes(p))) return false
    return matchesDateRange(o.meta, f.from, f.to)
  }

  private filtered(filter: SearchFilter = {}, objects = this.objects()): ContentObject[] {
    let selected = filter.scope ? this.select(objects, filter.scope) : objects
    if (filter.objectPaths) {
      const paths = new Set(filter.objectPaths.map(lower))
      selected = selected.filter(o => o.paths.some(p => paths.has(lower(p))))
    }
    if (filter.materials) {
      const ids = this.materialIds(objects, filter.materials)
      selected = selected.filter(o => ids.has(o.meta.path))
    }
    return selected.filter(o => this.matches(o, filter))
  }

  matchesFilter(rel: string, filter: SearchFilter): boolean {
    return this.filtered(filter).some(o => o.paths.some(p => same(p, rel)))
  }

  facets(scope?: ContentScope): LibraryFacets {
    const months = new Set<string>()
    const tags = new Map<string, number>()
    for (const o of this.filtered({ scope: scope ?? { selection: { kind: 'collection', name: 'all' } } })) {
      const recorded = optionalActivityTime(o.meta.created)
      if (recorded) months.add(activityDay(recorded).slice(0, 7))
      for (const tag of new Set(o.meta.classification.tags)) tags.set(tag, (tags.get(tag) ?? 0) + 1)
    }
    return {
      months: [...months].sort((a, b) => b.localeCompare(a)),
      tags: [...tags].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')),
    }
  }

  library(q: LibraryQuery): Paged<LibraryItem> {
    let objects = this.filtered({ ...q.filter, scope: q.scope ?? { selection: { kind: 'collection', name: q.pending ? 'pending' : 'all' } } })
    if (q.pending && q.scope) objects = this.select(objects, { selection: { kind: 'collection', name: 'pending' } })
    objects = objects.filter(o => (!q.path || same(o.meta.path, q.path) || o.paths.some(p => same(p, q.path!)))
      && (!q.fileState || o.file?.state === q.fileState)
      && (!q.kind || q.kind === (o.role === 'source' || o.meta.type === 'source-summary' ? 'file' : o.role === 'record' ? 'record' : 'note')))
    const tokens = (q.text ?? '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    const items = objects.flatMap(o => {
      const chunks = o.paths.flatMap(p => this.index.chunksOf(p))
      const c = o.meta.classification
      const haystack = lower([o.meta.title, o.meta.path, c.place, ...c.tags, ...c.people, ...chunks.map(c => c.text)].filter(Boolean).join('\n'))
      if (tokens.some(t => !haystack.includes(t))) return []
      const modified = [o.meta.modified, ...o.paths.map(p => this.index.getDoc(p)?.modified ?? '')].sort((a, b) => Date.parse(b) - Date.parse(a))[0]!
      return [{ path: o.meta.path, title: o.meta.title, kind: o.role === 'source' || o.meta.type === 'source-summary' ? 'file' as const : o.role === 'record' ? 'record' as const : 'note' as const,
        created: o.meta.created, modified, classification: o.meta.classification,
        preview: (chunks.find(c => c.path === o.summary) ?? chunks[0])?.text.replace(/\s+/g, ' ').slice(0, 180) ?? '',
        summaryPath: o.summary, summaryPaths: o.paths.filter(p => p !== o.meta.path && this.index.getDoc(p)?.type === 'source-summary'), sourceMissing: o.meta.type === 'source-summary',
        ...(o.file ? { file: { ...o.file, summaryPath: o.summary, classification: o.meta.classification } } : {}),
      }]
    })
    items.sort((a, b) => q.sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') || a.path.localeCompare(b.path) : Date.parse(q.sort === 'created' ? b.created : b.modified) - Date.parse(q.sort === 'created' ? a.created : a.modified) || a.path.localeCompare(b.path))
    return page(items, q)
  }

  search(q: SearchQuery): Paged<SearchHit> {
    const selected = this.filtered(q.filter)
    const excluded = new Set(q.excludePaths ?? [])
    const paths = selected.filter(o => !o.paths.some(p => excluded.has(p))).flatMap(o => o.paths)
    const indexed: SearchHit[] = []
    for (let offset = 0; ; offset += 200) {
      const batch = this.index.searchIndexed({ ...q, filter: { objectPaths: paths, types: q.filter?.types }, offset, limit: 200 })
      indexed.push(...batch.items)
      if (offset + batch.items.length >= batch.total || !batch.items.length) break
    }
    const byPath = new Map(selected.flatMap(o => o.paths.map(p => [p, o] as const)))
    const hits = new Map<string, SearchHit>()
    for (const hit of indexed) {
      const owner = byPath.get(hit.doc.path)
      if (!owner || hits.has(owner.meta.path)) continue
      // 文件内容的筛选在合并后的对象上判断，证据仍保留原文或摘要的真实片段。
      hits.set(owner.meta.path, hit)
    }
    const tokens = (q.text ?? '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    const needles = q.mode === 'any' ? expandWeighted(tokens) : tokens.map(text => ({ text, weight: 2 }))
    for (const o of selected) {
      if (hits.has(o.meta.path) || o.paths.some(p => excluded.has(p))) continue
      const c = o.meta.classification
      const chunks = o.paths.filter(p => !q.filter?.types?.length || q.filter.types.includes(this.index.getDoc(p)?.type ?? o.meta.type)).flatMap(p => this.index.chunksOf(p))
      const header = lower([o.meta.title, o.meta.path, c.place, ...c.tags, ...c.people].filter(Boolean).join(' '))
      const haystack = header + '\n' + lower(chunks.map(c => c.text).join('\n'))
      if (tokens.length && !(q.mode === 'any' ? needles.reduce((score, term) => score + (haystack.includes(term.text) ? term.weight : 0), 0) >= 2 : tokens.every(t => haystack.includes(t)))) continue
      const marks = needles.map(t => t.text)
      const first = chunks.find(c => marks.some(t => lower(c.text).includes(t))) ?? chunks[0]
      const chunk = first ?? { chunkId: '', path: o.meta.path, lineStart: 1, lineEnd: 1, text: '', generatedByAi: false }
      hits.set(o.meta.path, { doc: first ? this.index.getDoc(first.path) ?? o.meta : o.meta, chunk, ...makeSnippet(chunk.text, marks) })
    }
    const items = [...hits.values()]
    if (q.sort === 'time' || !tokens.length) items.sort((a, b) => {
      const left = byPath.get(a.doc.path)?.meta ?? a.doc
      const right = byPath.get(b.doc.path)?.meta ?? b.doc
      return right.created.localeCompare(left.created) || left.path.localeCompare(right.path)
    })
    return page(items, q)
  }

  stats(groupBy: 'folder' | 'tag' | 'date' | 'type', filter: SearchFilter = {}): { total: number; groups: { key: string; count: number }[] } {
    const objects = this.filtered(filter).filter(o => filter.types?.length || o.meta.type !== 'daily')
    const groups = new Map<string, Set<string>>()
    for (const o of objects) {
      const c = o.meta.classification
      const keys = groupBy === 'tag' ? c.tags : groupBy === 'date' ? [localDay(o.meta.start ?? o.meta.created)] : groupBy === 'type' ? [o.meta.type] : [path.posix.dirname(o.meta.path)]
      for (const key of keys) { const ids = groups.get(key) ?? new Set<string>(); ids.add(o.meta.path); groups.set(key, ids) }
    }
    return { total: objects.length, groups: [...groups].map(([key, ids]) => ({ key, count: ids.size }))
      .sort((a, b) => groupBy === 'date' ? a.key.localeCompare(b.key) : b.count - a.count || a.key.localeCompare(b.key)) }
  }

  terms(kind: 'tag' | 'place' | 'person', filter: SearchFilter = {}): { name: string; count: number }[] {
    const counts = new Map<string, number>()
    for (const o of this.filtered(filter)) {
      const c = o.meta.classification
      const values = kind === 'tag' ? c.tags : kind === 'person' ? c.people : c.place ? [c.place] : []
      for (const name of new Set(values)) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  timeline(from: string, to: string, filter: SearchFilter = {}): DocMeta[] {
    return this.filtered({ ...filter, from, to, types: filter.types?.length ? filter.types : ['idea', 'log', 'note', 'file'] })
      .map(o => o.meta).sort((a, b) => (a.start ?? a.created).localeCompare(b.start ?? b.created) || a.path.localeCompare(b.path)).slice(0, 2000)
  }
}
