import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { JotError } from '@shared/result'
import type { Chunk, DocMeta, DocType, LibraryQuery, LibraryItem, Paged, SearchFilter, SearchHit } from '@shared/types'
import { removeFileSync } from '../util/fs'
import { databaseUsage, maintainDatabase } from '../util/database'
import { localDay } from '../util/time'
import { buildMeta, isMarkdown } from '../vault/doc'
import { parseDoc } from '../vault/frontmatter'
import { hashText } from '../vault/vault'
import { chunkText } from './chunker'
import type { FileLink } from '@shared/files'
import type { FileProperties } from '../vault/metadata'
import { scanLinks } from '../vault/links'
import { matchesDateRange, matchesTime } from '../content/time'

// 索引服务：文件清单、片段、全文索引。只读库里的内容，不写库里的文件；整个索引可以重建。
// 见 docs/architecture.md。

const SCHEMA_VERSION = 10

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  path TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
  hash TEXT NOT NULL, mtime_ms REAL NOT NULL, size INTEGER NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL, day TEXT NOT NULL,
  place TEXT,
  generated_by_ai INTEGER NOT NULL DEFAULT 0, start TEXT, end TEXT, source_path TEXT, aliases TEXT,
  properties_json TEXT NOT NULL, occurred_at TEXT, invalid_properties INTEGER NOT NULL,
  sidecar_mtime_ms REAL, sidecar_size INTEGER
);
CREATE INDEX IF NOT EXISTS idx_documents_day ON documents(day);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_path, type);
CREATE TABLE IF NOT EXISTS chunks (
  rowid INTEGER PRIMARY KEY, chunk_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, seq INTEGER NOT NULL,
  text TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='trigram');
CREATE TABLE IF NOT EXISTS doc_tags (path TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (path, tag));
CREATE INDEX IF NOT EXISTS idx_doc_tags_tag ON doc_tags(tag);
CREATE TABLE IF NOT EXISTS doc_people (path TEXT NOT NULL, person TEXT NOT NULL, PRIMARY KEY (path, person));
CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (src, dst, kind));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`

interface DocRow {
  path: string; type: DocType; title: string; hash: string; size: number
  created: string; modified: string; place: string | null
  generated_by_ai: number
  start: string | null; end: string | null; source_path: string | null
  properties_json: string; occurred_at: string | null; invalid_properties: number
}

interface ChunkRow { chunk_id: string; path: string; text: string; line_start: number; line_end: number }

export interface IndexInput {
  properties?: FileProperties
  /** 调用方从原件登记中确定，不使用路径或原件头部推测。 */
  source?: boolean
  path: string
  text: string
  mtimeMs: number
  size: number
  birthtime: Date
  mtime: Date
}

export interface SearchQuery {
  text?: string
  /**
   * all（默认）：每个词都要出现。any：出现任意一个就算，出现得越多越靠前；
   * 较长的中文词还会拆成两个字一组来匹配，用于“全部出现”找不到时放宽查找。
   */
  mode?: 'all' | 'any'
  /** 编辑快照在助手中单独检索，不重复使用磁盘正文。 */
  excludePaths?: string[]
  filter?: SearchFilter
  sort?: 'relevance' | 'time'
  limit?: number
  offset?: number
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex')
const likeArg = (s: string) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`
const len = (s: string) => [...s].length

/**
 * 放宽查找时用的词：原来的词，加上较长的中文词拆出来的两字组合。
 * 例如“智能门锁二期”拆成 智能、能门、门锁、锁二、二期——原文里常常只出现其中一部分。
 */
export function expandTokens(tokens: string[]): string[] {
  return expandWeighted(tokens).map((t) => t.text)
}

/** 含这些字的两字组合几乎哪里都有，不拿来匹配 */
const COMMON = /[的了是在和有我你他她它们这那吗呢吧啊么什个不也就都很还一]/

/**
 * 带权重的版本：你写的原词算 2 分，拆出来的两字组合算 1 分。
 * 放宽查找时至少要 2 分才算相关，这样只碰巧对上一个两字组合的内容不会混进来。
 */
export function expandWeighted(tokens: string[]): { text: string; weight: number }[] {
  const out = new Map<string, number>()
  for (const t of tokens) out.set(t, 2)
  for (const t of tokens) {
    const chars = [...t]
    if (chars.length < 4 || !/[\u4e00-\u9fff]/.test(t)) continue
    for (let i = 0; i + 1 < chars.length; i++) {
      const piece = chars[i]! + chars[i + 1]!
      if (/^[\u4e00-\u9fff]{2}$/.test(piece) && !COMMON.test(piece) && !out.has(piece)) out.set(piece, 1)
    }
  }
  return [...out].slice(0, 24).map(([text, weight]) => ({ text, weight }))
}

/** 以关键词为中心截取一段，并算出高亮区间 */
export function makeSnippet(text: string, tokens: string[], width = 90): { snippet: string; highlights: [number, number][] } {
  const flat = text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  const needles = tokens.map((t) => t.toLowerCase()).filter(Boolean)
  let first = -1
  for (const n of needles) {
    const i = lower.indexOf(n)
    if (i >= 0 && (first < 0 || i < first)) first = i
  }
  const from = first < 0 ? 0 : Math.max(0, first - Math.floor(width / 3))
  const to = Math.min(flat.length, from + width)
  const prefix = from > 0 ? '…' : ''
  const snippet = prefix + flat.slice(from, to) + (to < flat.length ? '…' : '')
  const highlights: [number, number][] = []
  const hay = snippet.toLowerCase()
  for (const n of needles) {
    for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length)) highlights.push([i, i + n.length])
  }
  highlights.sort((a, b) => a[0] - b[0])
  return { snippet, highlights }
}

export interface ContentQueries {
  search(q: SearchQuery): Paged<SearchHit>
  library(q: LibraryQuery): Paged<LibraryItem>
  matchesFilter(rel: string, filter: SearchFilter): boolean
  stats(groupBy: 'folder' | 'tag' | 'date' | 'type', filter?: SearchFilter): { total: number; groups: { key: string; count: number }[] }
  terms(kind: 'tag' | 'place' | 'person', filter?: SearchFilter): { name: string; count: number }[]
  timeline(from: string, to: string, filter?: SearchFilter): DocMeta[]
}

export class IndexService {
  private content: ContentQueries | null = null
  setContentQueries(content: ContentQueries): void { this.content = content }

  private db: Database.Database | null = null
  get isOpen(): boolean {
    return this.db !== null
  }

  private get d(): Database.Database {
    if (!this.db) throw new JotError('VAULT_NOT_OPEN', '还没有打开库')
    return this.db
  }

  databaseUsage() { return databaseUsage(this.d, 'index') }
  maintainStorage(compact: boolean, automatic = false): number { return maintainDatabase(this.d, compact, automatic) }

  /** 打开索引库。文件损坏或版本不对时删掉重建——索引可以从库里的文件重新生成。 */
  open(file: string): void {
    this.close()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const create = () => {
      const db = new Database(file)
      try {
        db.pragma('journal_mode = WAL')
        db.exec(SCHEMA)
        const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
        if (v && Number(v.value) !== SCHEMA_VERSION) throw new Error('索引版本不匹配')
        return db
      } catch (e) {
        db.close()
        throw e
      }
    }
    let db: Database.Database
    try {
      db = create()
    } catch {
      for (const suffix of ['', '-wal', '-shm']) removeFileSync(file + suffix)
      db = create()
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION))
    this.db = db
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  clear(): void {
    this.d.exec('DELETE FROM documents; DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM doc_tags; DELETE FROM doc_people; DELETE FROM links;')
  }

  // ---------- 写入 ----------

  /** 文件的修改时间和大小都没变时不需要重新索引 */
  needsUpdate(rel: string, mtimeMs: number, size: number, sidecar: { mtimeMs: number; size: number } | null = null): boolean {
    const row = this.d.prepare('SELECT mtime_ms,size,sidecar_mtime_ms,sidecar_size FROM documents WHERE path=?').get(rel) as { mtime_ms: number; size: number; sidecar_mtime_ms: number | null; sidecar_size: number | null } | undefined
    return !row || row.mtime_ms !== mtimeMs || row.size !== size || row.sidecar_mtime_ms !== (sidecar?.mtimeMs ?? null) || row.sidecar_size !== (sidecar?.size ?? null)
  }

  allPaths(): string[] {
    return (this.d.prepare('SELECT path FROM documents').all() as { path: string }[]).map((r) => r.path)
  }

  /** 把一个文件写入索引。内容没变时只更新时间。返回它的元数据。 */
  upsert(input: IndexInput): DocMeta {
    const db = this.d
    const attachment = input.properties?.attachment ?? (input.source || !isMarkdown(input.path))
    const rawParsed = !attachment && isMarkdown(input.path) ? parseDoc(input.text)
      : { data: input.properties?.data ?? {}, body: input.text, bodyStartLine: 1, hasFrontmatter: false, invalid: false }
    const parsed = { ...rawParsed, data: input.properties?.data ?? rawParsed.data, invalid: input.properties?.invalid ?? rawParsed.invalid }
    let meta = buildMeta(input.path, parsed, input)
    if (attachment) {
      meta = { ...meta, type: 'file', role: 'source', title: path.posix.basename(input.path),
        generatedByAi: false, start: undefined, end: undefined, sourcePath: undefined }
    }
    if (input.properties?.sidecar && input.properties.sidecar.mtimeMs > input.mtimeMs) meta.modified = new Date(input.properties.sidecar.mtimeMs).toISOString()
    const hash = hashText(input.text)
    const c = meta.classification
    const day = localDay(meta.start ?? meta.occurredAt ?? meta.created) || localDay(input.birthtime)

    db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO documents
         (path, type, title, hash, mtime_ms, size, created, modified, day, place, generated_by_ai, start, end, source_path, aliases, properties_json,occurred_at,invalid_properties,sidecar_mtime_ms,sidecar_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        meta.path, meta.type, meta.title, hash, input.mtimeMs, input.size, meta.created, meta.modified, day,
        c.place ?? null, meta.generatedByAi ? 1 : 0,
        meta.start ?? null, meta.end ?? null, meta.sourcePath ?? null,
        JSON.stringify(!attachment && Array.isArray(parsed.data.aliases) ? (parsed.data.aliases as unknown[]).map(String) : []),
        JSON.stringify(meta.properties ?? {}), meta.occurredAt ?? null, meta.invalidProperties ? 1 : 0,
        input.properties?.sidecar?.mtimeMs ?? null, input.properties?.sidecar?.size ?? null,
      )
      db.prepare('DELETE FROM doc_tags WHERE path = ?').run(meta.path)
      db.prepare('DELETE FROM doc_people WHERE path = ?').run(meta.path)
      const tag = db.prepare('INSERT OR IGNORE INTO doc_tags(path, tag) VALUES (?, ?)')
      for (const t of c.tags) tag.run(meta.path, t)
      const person = db.prepare('INSERT OR IGNORE INTO doc_people(path, person) VALUES (?, ?)')
      for (const p of c.people) person.run(meta.path, p)

      this.deleteChunks(meta.path)
      const insChunk = db.prepare('INSERT INTO chunks(chunk_id, path, seq, text, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)')
      const insFts = db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)')
      const exists = db.prepare('SELECT 1 FROM chunks WHERE chunk_id = ?')
      chunkText(parsed.body, parsed.bodyStartLine).forEach((ch, seq) => {
        // 片段编号：内容相同则编号不变；撞号时加盐重算
        let id = ''
        for (let salt = 0; ; salt++) {
          id = sha(`${meta.path}\n${ch.lineStart}\n${ch.text}\n${salt}`).slice(0, 6)
          if (!exists.get(id)) break
        }
        const { lastInsertRowid } = insChunk.run(id, meta.path, seq, ch.text, ch.lineStart, ch.lineEnd)
        // 第一个片段的全文索引里带上标题和归类：按文件名、项目名、标签、人物也能搜到
        const head = [meta.title, meta.path, c.place, ...c.tags, ...c.people].filter(Boolean).join(' ')
        insFts.run(lastInsertRowid, seq === 0 ? `${head}\n${ch.text}` : ch.text)
      })
      db.prepare('DELETE FROM links WHERE src = ?').run(meta.path)
      const link = db.prepare('INSERT OR IGNORE INTO links(src,dst,kind) VALUES (?,?,?)')
      if (!attachment) for (const span of scanLinks(parsed.body)) link.run(meta.path, span.target, span.kind)
      if (meta.sourcePath) link.run(meta.path, meta.sourcePath, 'source')
    })()
    return meta
  }

  private deleteChunks(rel: string): void {
    const db = this.d
    db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE path = ?)').run(rel)
    db.prepare('DELETE FROM chunks WHERE path = ?').run(rel)
  }

  remove(rel: string): void {
    const db = this.d
    db.transaction(() => {
      this.deleteChunks(rel)
      for (const t of ['documents', 'doc_tags', 'doc_people']) db.prepare(`DELETE FROM ${t} WHERE path = ?`).run(rel)
      db.prepare('DELETE FROM links WHERE src = ?').run(rel)
    })()
  }

  // ---------- 读取 ----------

  private toMeta(row: DocRow, classification?: Pick<DocMeta['classification'], 'tags' | 'people'>): DocMeta {
    const tags = classification?.tags ?? (this.d.prepare('SELECT tag FROM doc_tags WHERE path=? ORDER BY rowid').all(row.path) as { tag: string }[]).map(entry => entry.tag)
    const people = classification?.people ?? (this.d.prepare('SELECT person FROM doc_people WHERE path=? ORDER BY rowid').all(row.path) as { person: string }[]).map(entry => entry.person)
    return {
      path: row.path, type: row.type, title: row.title,
      role: row.type === 'file' ? 'source' : ['idea', 'log'].includes(row.type) ? 'record' : ['source-summary', 'daily'].includes(row.type) ? 'derived' : 'note',
      created: row.created, modified: row.modified, size: row.size, generatedByAi: row.generated_by_ai === 1,
      properties: JSON.parse(row.properties_json) as Record<string, unknown>, invalidProperties: row.invalid_properties === 1,
      occurredAt: row.occurred_at ?? undefined,
      classification: { tags, people, place: row.place ?? undefined },
      start: row.start ?? undefined, end: row.end ?? undefined, sourcePath: row.source_path ?? undefined,
    }
  }

  private toChunk(row: ChunkRow, doc: DocRow | DocMeta): Chunk {
    const ai = 'generated_by_ai' in doc ? doc.generated_by_ai === 1 : doc.generatedByAi
    return { chunkId: row.chunk_id, path: row.path, lineStart: row.line_start, lineEnd: row.line_end, text: row.text, generatedByAi: ai }
  }

  getDoc(rel: string): DocMeta | null {
    const row = this.d.prepare('SELECT * FROM documents WHERE path = ?').get(rel) as DocRow | undefined
    return row ? this.toMeta(row) : null
  }

  /** 批量读取当前投影，列表与范围过滤不逐文件重复查属性。 */
  allDocs(): DocMeta[] {
    const rows = this.d.prepare('SELECT * FROM documents ORDER BY path').all() as DocRow[]
    const tags = new Map<string, string[]>(), people = new Map<string, string[]>()
    for (const row of this.d.prepare('SELECT path,tag FROM doc_tags ORDER BY rowid').all() as { path: string; tag: string }[]) {
      const values = tags.get(row.path) ?? []; values.push(row.tag); tags.set(row.path, values)
    }
    for (const row of this.d.prepare('SELECT path,person FROM doc_people ORDER BY rowid').all() as { path: string; person: string }[]) {
      const values = people.get(row.path) ?? []; values.push(row.person); people.set(row.path, values)
    }
    return rows.map(row => this.toMeta(row, { tags: tags.get(row.path) ?? [], people: people.get(row.path) ?? [] }))
  }

  linkEntries(): { src: string; dst: string; kind: FileLink['kind'] }[] {
    return this.d.prepare('SELECT src,dst,kind FROM links').all() as { src: string; dst: string; kind: FileLink['kind'] }[]
  }

  getChunk(chunkId: string): Chunk | null {
    const row = this.d.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get(chunkId) as ChunkRow | undefined
    if (!row) return null
    const doc = this.d.prepare('SELECT * FROM documents WHERE path = ?').get(row.path) as DocRow | undefined
    return doc ? this.toChunk(row, doc) : null
  }

  /** 一个文件的片段；给了行范围时只返回与之相交的片段 */
  chunksOf(rel: string, lines?: [number, number]): Chunk[] {
    const doc = this.d.prepare('SELECT * FROM documents WHERE path = ?').get(rel) as DocRow | undefined
    if (!doc) return []
    const rows = (lines
      ? this.d.prepare('SELECT * FROM chunks WHERE path = ? AND line_end >= ? AND line_start <= ? ORDER BY seq').all(rel, lines[0], lines[1])
      : this.d.prepare('SELECT * FROM chunks WHERE path = ? ORDER BY seq').all(rel)) as ChunkRow[]
    return rows.map((r) => this.toChunk(r, doc))
  }

  /** 把筛选条件变成 SQL 片段（表别名 d） */
  private filterSql(filter: SearchFilter = {}): { where: string[]; params: unknown[] } {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.objectPaths) {
      where.push('d.path IN (SELECT value FROM json_each(?))')
      params.push(JSON.stringify(filter.objectPaths))
    }
    if (filter.materials) {
      const union: string[] = []
      for (const material of filter.materials) {
        if (material.kind === 'file') {
          union.push('(d.path = ? OR d.source_path = ? OR d.path = (SELECT source_path FROM documents WHERE path = ?))')
          params.push(material.value, material.value, material.value)
        } else {
          union.push(String.raw`(d.path LIKE ? ESCAPE '\' OR d.source_path LIKE ? ESCAPE '\')`)
          const prefix = material.value.replace(/[\\%_]/g, c => '\\' + c).replace(/\/$/, '') + '/%'
          params.push(prefix, prefix)
        }
      }
      where.push(union.length ? '(' + union.join(' OR ') + ')' : '0')
    }
    if (filter.scope?.selection.kind === 'collection') {
      const name = filter.scope.selection.name
      if (name === 'ideas' || name === 'pending') {
        where.push('d.path LIKE ? COLLATE NOCASE')
        params.push((name === 'ideas' ? 'ideas' : 'inbox') + '/%')
      } else where.push("(d.path LIKE 'ideas/%' OR d.path LIKE 'inbox/%' OR d.path LIKE 'content/%')")
    } else if (filter.scope?.selection.kind === 'directory') {
      const selection = filter.scope.selection
      where.push('d.path LIKE ? ESCAPE \'\\\'')
      params.push(selection.path.replace(/[\\%_]/g, c => '\\' + c).replace(/\/$/, '') + '/%')
      if (!selection.recursive) {
        where.push('instr(substr(d.path, ?), \'/\') = 0')
        params.push(selection.path.replace(/\/$/, '').length + 2)
      }
    }
    if (filter.types?.length) {
      where.push(`d.type IN (${filter.types.map(() => '?').join(',')})`)
      params.push(...filter.types)
    }
    for (const [col, val] of [['place', filter.place]] as const) {
      if (val) {
        const value = `d.${col}`
        where.push(`${value} = ?`)
        params.push(val)
      }
    }
    const ownerPath = 'd.path'
    for (const t of filter.tags ?? []) {
      // 分层标签：筛「生活」时也包含「生活/零食」
      where.push('EXISTS (SELECT 1 FROM doc_tags t WHERE t.path = ' + ownerPath + ' AND (t.tag = ? OR t.tag LIKE ? ESCAPE \'\\\'))')
      params.push(t, t.replace(/[\\%_]/g, (c) => '\\' + c) + '/%')
    }
    for (const p of filter.people ?? []) {
      where.push('EXISTS (SELECT 1 FROM doc_people p WHERE p.path = ' + ownerPath + ' AND p.person = ?)')
      params.push(p)
    }
    if (filter.from || filter.to || filter.scope?.time) {
      const paths = this.allDocs().filter(doc => matchesDateRange(doc, filter.from, filter.to) && (!filter.scope?.time || matchesTime(doc, filter.scope.time))).map(doc => doc.path)
      where.push('d.path IN (SELECT value FROM json_each(?))')
      params.push(JSON.stringify(paths))
    }
    return { where, params }
  }

  /**
   * 搜索。三个字及以上的词走全文索引；更短的词索引用不上，退回子串匹配（确认清单 V05）。
   * 多个词之间是“并且”。每个文件只返回最相关的一个片段。
   */
  search(q: SearchQuery): Paged<SearchHit> {
    return this.content ? this.content.search(q) : this.searchIndexed(q)
  }

  /** 只读全文证据查询；共同范围服务在完整结果上按对象合并。 */
  searchIndexed(q: SearchQuery): Paged<SearchHit> {
    const db = this.d
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 200)
    const offset = Math.max(q.offset ?? 0, 0)
    const tokens = (q.text ?? '').trim().split(/\s+/).filter(Boolean)
    const f = this.filterSql(q.filter)
    if (q.excludePaths?.length) {
      f.where.push(`d.path NOT IN (${q.excludePaths.map(() => '?').join(',')})`)
      f.params.push(...q.excludePaths)
    }
    const and = (parts: string[]) => (parts.length ? 'WHERE ' + parts.join(' AND ') : '')

    type Row = DocRow & { c_chunk_id: string | null; c_text: string | null; c_line_start: number | null; c_line_end: number | null }
    const cols = 'd.*, c.chunk_id AS c_chunk_id, c.text AS c_text, c.line_start AS c_line_start, c.line_end AS c_line_end'
    let rows: Row[]
    let total: number

    if (tokens.length === 0) {
      total = (db.prepare(`SELECT COUNT(*) n FROM documents d ${and(f.where)}`).get(...f.params) as { n: number }).n
      rows = db
        .prepare(`SELECT ${cols} FROM documents d LEFT JOIN chunks c ON c.path = d.path AND c.seq = 0 ${and(f.where)} ORDER BY d.created DESC, d.path LIMIT ? OFFSET ?`)
        .all(...f.params, limit, offset) as Row[]
    } else {
      let matched: string
      let ftsParams: unknown[]
      if (q.mode === 'any') {
        // 放宽：出现任意一个词就算，按出现了几个词排序
        const pieces = expandWeighted(tokens)
        const points = pieces.map((p) => `${p.weight} * (text LIKE ? ESCAPE '\\')`).join(' + ')
        matched = `SELECT rid, score FROM (SELECT rowid AS rid, -(${points}) AS score FROM chunks_fts) WHERE score <= -2`
        ftsParams = pieces.map((p) => likeArg(p.text))
      } else {
        const long = tokens.filter((t) => len(t) >= 3)
        const short = tokens.filter((t) => len(t) < 3)
        const ftsWhere: string[] = []
        ftsParams = []
        if (long.length) {
          ftsWhere.push('chunks_fts MATCH ?')
          ftsParams.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' '))
        }
        for (const t of short) {
          ftsWhere.push("chunks_fts.text LIKE ? ESCAPE '\\'")
          ftsParams.push(likeArg(t))
        }
        matched = `SELECT rowid AS rid, ${long.length ? 'bm25(chunks_fts)' : '0'} AS score FROM chunks_fts WHERE ${ftsWhere.join(' AND ')}`
      }
      const ranked = `
        WITH m AS (${matched}),
        r AS (
          SELECT c.rowid AS crow, c.path AS path, m.score AS score,
                 ROW_NUMBER() OVER (PARTITION BY c.path ORDER BY m.score, c.seq) AS rn
          FROM m JOIN chunks c ON c.rowid = m.rid JOIN documents d ON d.path = c.path ${and(f.where)}
        )`
      const args = [...ftsParams, ...f.params]
      total = (db.prepare(`${ranked} SELECT COUNT(*) n FROM r WHERE rn = 1`).get(...args) as { n: number }).n
      const order = q.sort === 'time' ? 'd.created DESC, r.score' : 'r.score, d.created DESC'
      rows = db
        .prepare(`${ranked} SELECT ${cols} FROM r JOIN chunks c ON c.rowid = r.crow JOIN documents d ON d.path = r.path WHERE r.rn = 1 ORDER BY ${order}, d.path LIMIT ? OFFSET ?`)
        .all(...args, limit, offset) as Row[]
    }

    const marks = q.mode === 'any' ? expandTokens(tokens) : tokens
    const items = rows.map((row): SearchHit => {
      const doc = this.toMeta(row)
      const chunk: Chunk = {
        chunkId: row.c_chunk_id ?? '', path: row.path, lineStart: row.c_line_start ?? 1, lineEnd: row.c_line_end ?? 1,
        text: row.c_text ?? '', generatedByAi: doc.generatedByAi,
      }
      return { doc, chunk, ...makeSnippet(chunk.text, marks) }
    })
    return { items, total }
  }

  library(q: LibraryQuery): Paged<LibraryItem> {
    if (!this.content) throw new Error('内容查询服务未连接')
    return this.content.library(q)
  }

  matchesFilter(rel: string, filter: SearchFilter): boolean {
    if (this.content) return this.content.matchesFilter(rel, filter)
    const f = this.filterSql(filter)
    const conditions = ['d.path = ?', ...f.where]
    return !!this.d.prepare('SELECT 1 FROM documents d WHERE ' + conditions.join(' AND ')).get(rel, ...f.params)
  }

  materialTerms(kind: 'tag' | 'place' | 'person', materials: NonNullable<SearchFilter['materials']>): { name: string; count: number }[] {
    if (this.content) return this.content.terms(kind, { materials })
    const f = this.filterSql({ materials })
    const query = kind === 'place'
      ? 'SELECT d.place AS name, COUNT(*) count FROM documents d'
      : kind === 'person'
        ? 'SELECT t.person AS name, COUNT(*) count FROM doc_people t JOIN documents d ON d.path=t.path'
        : 'SELECT t.tag AS name, COUNT(*) count FROM doc_tags t JOIN documents d ON d.path=t.path'
    return this.d.prepare(query + ' WHERE ' + f.where.join(' AND ') + ' GROUP BY name HAVING name IS NOT NULL ORDER BY count DESC, name').all(...f.params) as { name: string; count: number }[]
  }

  /** 按名称快速查找文件：完全相同的排最前，其次是开头匹配，再按最近修改 */
  quickOpen(query: string, limit = 20): DocMeta[] {
    const q = query.trim()
    const n = Math.min(Math.max(limit, 1), 100)
    const rows = (q
      ? this.d
          .prepare(
            `SELECT * FROM documents d WHERE d.title LIKE ? ESCAPE '\\' OR d.path LIKE ? ESCAPE '\\'
             ORDER BY (d.title = ? COLLATE NOCASE) DESC, (d.title LIKE ? ESCAPE '\\') DESC, d.modified DESC LIMIT ?`,
          )
          .all(likeArg(q), likeArg(q), q, likeArg(q).slice(1), n)
      : this.d.prepare('SELECT * FROM documents d ORDER BY d.modified DESC LIMIT ?').all(n)) as DocRow[]
    return rows.map((r) => this.toMeta(r))
  }

  /**
   * 一段时间内的记录，按发生的时间排序。默认只包含你留下的记录（想法、记事、笔记、文件），
   * 不含摘要页和日总结；要别的类型就在 filter.types 里指定。
   */
  timeline(from: string, to: string, filter: SearchFilter = {}): DocMeta[] {
    if (this.content) return this.content.timeline(from, to, filter)
    const f = this.filterSql({ ...filter, types: filter.types?.length ? filter.types : ['idea', 'log', 'note', 'file'], from, to })
    const rows = this.d.prepare(`SELECT d.* FROM documents d WHERE ${f.where.join(' AND ')} ORDER BY COALESCE(d.start, d.created), d.path LIMIT 2000`).all(...f.params) as DocRow[]
    return rows.map((r) => this.toMeta(r))
  }

  /**
   * 正式查询由共同范围服务合并原件与摘要后统计；独立索引按当前投影分组。
   */
  stats(groupBy: 'folder' | 'tag' | 'date' | 'type', filter: SearchFilter = {}): { key: string; count: number }[] {
    if (this.content) return this.content.stats(groupBy, filter).groups
    const f = this.filterSql(filter)
    const rows = this.d.prepare('SELECT d.* FROM documents d' + (f.where.length ? ' WHERE ' + f.where.join(' AND ') : '')).all(...f.params) as DocRow[]
    const groups = new Map<string, number>()
    for (const row of rows) {
      if (row.type === 'daily' || row.type === 'source-summary' && !filter.types?.includes('source-summary')) continue
      const keys = groupBy === 'tag' ? this.toMeta(row).classification.tags : [groupBy === 'folder' ? path.posix.dirname(row.path) : groupBy === 'date' ? localDay(row.created) : row.type]
      for (const key of keys) groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    return [...groups].map(([key, count]) => ({ key, count })).sort((a, b) => groupBy === 'date' ? a.key.localeCompare(b.key) : b.count - a.count || a.key.localeCompare(b.key))
  }

  /** 用到某个标签、地点或人物的全部文件。标签带下一层的（生活 也包含 生活/零食）要另外传 withChildren。 */
  pathsUsing(kind: 'tag' | 'place' | 'person', name: string, withChildren = false): string[] {
    const child = name.replace(/[\\%_]/g, (c) => '\\' + c) + '/%'
    const rows =
      kind === 'tag'
        ? this.d.prepare(`SELECT DISTINCT path FROM doc_tags WHERE tag = ?${withChildren ? " OR tag LIKE ? ESCAPE '\\'" : ''}`).all(...(withChildren ? [name, child] : [name]))
        : kind === 'person'
          ? this.d.prepare('SELECT DISTINCT path FROM doc_people WHERE person = ?').all(name)
          : this.d.prepare(`SELECT path FROM documents WHERE ${kind} = ?`).all(name)
    return (rows as { path: string }[]).map((r) => r.path)
  }

  /** 待整理按当前条目计数，原件与摘要合并。 */
  inboxCount(): number {
    if (this.content) return this.content.library({ pending: true, limit: 1 }).total
    return (this.d.prepare("SELECT COUNT(*) n FROM documents WHERE path LIKE 'inbox/%' COLLATE NOCASE AND type IN ('idea','log','note','file','source-summary')").get() as { n: number }).n
  }

  /** 某一类词（标签、地点、人物）及其使用次数，用得多的在前 */
  filterTerms(kind: 'tag' | 'place' | 'person', filter: SearchFilter = {}): { name: string; count: number }[] {
    if (this.content) return this.content.terms(kind, filter)
    return filter.materials ? this.materialTerms(kind, filter.materials) : this.termCounts(kind)
  }

  termCounts(kind: 'tag' | 'place' | 'person'): { name: string; count: number }[] {
    if (this.content) return this.content.terms(kind)
    const sql =
      kind === 'tag' ? 'SELECT tag AS name, COUNT(*) AS count FROM doc_tags GROUP BY tag'
      : kind === 'person' ? 'SELECT person AS name, COUNT(*) AS count FROM doc_people GROUP BY person'
      : 'SELECT place AS name, COUNT(*) AS count FROM documents WHERE place IS NOT NULL GROUP BY place'
    return this.d.prepare(`${sql} ORDER BY count DESC, name`).all() as { name: string; count: number }[]
  }

  statistics(groupBy: 'folder' | 'tag' | 'date' | 'type', filter: SearchFilter = {}): { total: number; groups: { key: string; count: number }[] } {
    if (this.content) return this.content.stats(groupBy, filter)
    const groups = this.stats(groupBy, filter)
    return { groups, total: groups.reduce((n, r) => n + r.count, 0) }
  }
  count(): number {
    return (this.d.prepare('SELECT COUNT(*) n FROM documents').get() as { n: number }).n
  }
}