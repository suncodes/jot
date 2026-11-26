import { readPage, type ReadRange } from './read-page'
import fs from 'node:fs'
import path from 'node:path'
import type { AppOperations } from '../operations/service'
import { createHash } from 'node:crypto'
import type { Chunk, Doc, DocMeta, SearchFilter, VaultChange } from '@shared/types'
import type { MoveResult } from '@shared/files'
import type { ToolConfirmation } from '@shared/assistant'
import { JotError } from '@shared/result'
import { hashText, type VaultService } from '../vault/vault'
import { isSidecar, sidecarPath } from '../vault/metadata'
import { buildMeta, isMarkdown } from '../vault/doc'
import { parseDoc } from '../vault/frontmatter'
import type { IndexService } from '../index/index'
import { chunkText } from '../index/chunker'
import { writeFileAtomic } from '../util/fs'
import { verifyTextFile } from '../util/read-back'
import { assertMovable, indexedPath, insidePath, resolveFile, samePath, type FileLocation } from './file-paths'

export type ConfirmFiles = (title: string, targets: ToolConfirmation['targets']) => Promise<boolean>
export interface AgentFileDeps {
  operations: () => AppOperations
  vault: VaultService
  index: IndexService
  mutate: <T>(operation: () => Promise<T>) => Promise<T>
  changed: () => Promise<void>
  trashed: (paths: string[]) => void
  moved: (paths: MoveResult['paths']) => void | Promise<void>
}
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new JotError('CANCELLED', '操作已停止') }
const binaryExtension = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|7z|rar|gz|exe|dll|db|sqlite3?|png|jpe?g|gif|bmp|ico|webp|mp[34]|wav|woff2?|ttf)$/i
function textFile(file: string, bytes: Buffer): string {
  if (binaryExtension.test(file)) throw new JotError('UNSUPPORTED_FORMAT', '此格式不支持原文读取或编辑：' + file)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new JotError('UNSUPPORTED_FORMAT', '只支持 UTF-8 文本文件：' + file) }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new JotError('UNSUPPORTED_FORMAT', '不能将二进制文件作为文本读写：' + file)
  return text
}

/** 软件业务操作仍只接受库内容路径；普通文件工具使用 resolveFile。 */
export function agentPath(vault: VaultService, raw: string): string {
  const location = resolveFile(vault, raw)
  const rel = indexedPath(location)
  if (!rel) throw new JotError('WRITE_DENIED', '此软件操作只管理库内内容；其他文件请使用通用文件工具')
  vault.abs(rel)
  return rel
}

/** 一套文件工具：相对路径以库根为基准，绝对路径直接访问磁盘。 */
export class AgentFiles {
  constructor(private readonly deps: AgentFileDeps) {}
  path(raw: string): string { return agentPath(this.deps.vault, raw) }
  private resolve(raw: string, sidecar = false) { return resolveFile(this.deps.vault, raw, sidecar) }
  private notify(locations: FileLocation[], kind: VaultChange['kind'] = 'change'): void {
    const changes = locations.flatMap(location => {
      const rel = indexedPath(location)
      return rel ? [{ path: rel, kind }] : []
    })
    if (changes.length) this.deps.vault.notifyChanges(...changes)
  }
  allowed(raw: string, filter: SearchFilter): boolean {
    const location = this.resolve(raw), rel = location.relative
    const selected = !filter.materials || filter.materials.some(ref => {
      const target = this.resolve(ref.value)
      return ref.kind === 'file' ? samePath(location.absolute, target.absolute) : insidePath(location.absolute, target.absolute)
    }) || rel !== undefined && this.deps.index.matchesFilter(rel, { materials: filter.materials })
    return selected && (!filter.scope || rel !== undefined && this.deps.index.matchesFilter(rel, { scope: filter.scope }))
  }
  private async raw(location: FileLocation): Promise<{ text: string; stat: fs.Stats }> {
    const stat = await fs.promises.stat(location.absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!stat?.isFile()) throw new JotError('NOT_FOUND', '文件不存在：' + location.path + '，请重新列目录或搜索')
    if (stat.size > 10 * 1024 * 1024) throw new JotError('UNSUPPORTED_FORMAT', '文件过大，请先拆分后读取')
    return { text: textFile(location.path, await fs.promises.readFile(location.absolute)), stat }
  }
  async read(raw: string, filter: SearchFilter): Promise<Doc> {
    const location = this.resolve(raw.replace(/:\d+$/, ''))
    if (!this.allowed(location.path, filter)) throw new JotError('WRITE_DENIED', '超出本轮限定材料')
    const { text, stat } = await this.raw(location)
    const parsed = isMarkdown(location.path) ? parseDoc(text) : { data: {}, body: text, bodyStartLine: 1, hasFrontmatter: false, invalid: false }
    const properties = location.relative !== undefined ? await this.deps.vault.metadata.read(location.relative, text) : undefined
    const meta = buildMeta(location.path, { ...parsed, ...(properties ? { data: properties.data, invalid: properties.invalid } : {}) }, stat)
    return { ...meta, ...(properties?.attachment ? { type: 'file' as const, role: 'source' as const, title: path.posix.basename(location.path), generatedByAi: false, sourcePath: undefined } : {}), size: stat.size, body: text, hash: hashText(text), bodyStartLine: 1, editable: true }
  }
  /** 时间线只取当前库文件元信息，二进制附件也能说明有更新。 */
  async metadata(raw: string, filter: SearchFilter): Promise<DocMeta> {
    const rel = this.path(raw)
    if (!this.allowed(rel, filter)) throw new JotError('WRITE_DENIED', '超出本轮限定材料')
    return this.deps.vault.read({ path: rel })
  }
  private citation(doc: Doc, chunk: Pick<Chunk, 'text' | 'lineStart' | 'lineEnd'>): Chunk {
    return { text: chunk.text, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, path: doc.path, generatedByAi: doc.generatedByAi, sourcePath: doc.sourcePath,
      chunkId: createHash('sha256').update(doc.path + ':' + chunk.lineStart + ':' + chunk.text).digest('hex').slice(0, 6) }
  }
  chunks(doc: Doc): Chunk[] { return chunkText(doc.body, doc.bodyStartLine).map(chunk => this.citation(doc, chunk)) }
  page(doc: Doc, range: ReadRange = {}) {
    const page = readPage(doc, range)
    return { ...page, chunk: page.text ? this.citation(doc, page) : null }
  }
  async list(raw = '', filter: SearchFilter = {}): Promise<{ path: string; kind: 'file' | 'folder' }[]> {
    const location = this.resolve(raw)
    const entries = await fs.promises.readdir(location.absolute, { withFileTypes: true })
    const rows: { path: string; kind: 'file' | 'folder' }[] = []
    for (const entry of entries) {
      // 递归查找不跟随链接，避免循环；明确指定的链接路径可直接访问。
      if (entry.isSymbolicLink() || location.relative !== undefined && (entry.name === '.jot' || isSidecar(entry.name))) continue
      if (!raw && !/^(ideas|content|inbox|wiki|journal)$/.test(entry.name)) continue
      const child = this.resolve(path.join(location.absolute, entry.name))
      const kind = entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : null
      if (!kind) continue
      if (filter.materials || filter.scope) {
        const ancestor = kind === 'folder' && filter.materials?.some(ref => insidePath(this.resolve(ref.value).absolute, child.absolute))
        const related = kind === 'folder' && this.deps.index.allPaths().some(p => insidePath(this.resolve(p).absolute, child.absolute) && this.allowed(p, filter))
        if (!ancestor && !related && !this.allowed(child.path, filter)) continue
      }
      rows.push({ path: child.path, kind })
    }
    return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path, 'zh-CN'))
  }
  async find(input: { directory?: string; pattern?: string; query?: string; limit?: number; offset?: number }, scope: SearchFilter, signal?: AbortSignal) {
    const directory = input.directory ? this.resolve(input.directory).path : ''
    if (input.pattern && input.pattern.length > 200) throw new JotError('INVALID_INPUT', '文件匹配模式最多200字符')
    if (input.query !== undefined && !input.query.trim()) throw new JotError('INVALID_INPUT', '原文查询不能为空')
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100), offset = Math.max(input.offset ?? 0, 0)
    const items: { path: string; line?: number; text?: string }[] = []
    const skipped: { path: string; reason: string }[] = []
    let visited = 0, matches = 0, limited = false
    const walk = async (dir: string): Promise<void> => {
      cancelled(signal)
      for (const entry of await this.list(dir, scope)) {
        cancelled(signal)
        if (++visited > 20000) { limited = true; return }
        if (entry.kind === 'folder') { await walk(entry.path); if (limited) return; continue }
        const relative = directory ? path.relative(this.resolve(directory).absolute, this.resolve(entry.path).absolute).split(path.sep).join('/') : entry.path
        const pattern = input.pattern ?? '**/*'
        if (!path.posix.matchesGlob(pattern.includes('/') ? relative : path.posix.basename(relative), pattern)) continue
        if (input.query === undefined) {
          if (matches++ >= offset && items.length < limit) items.push({ path: entry.path })
        } else {
          try {
            const doc = await this.read(entry.path, scope)
            const query = input.query.toLocaleLowerCase(), lines = doc.body.split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
              const position = lines[i]!.toLocaleLowerCase().indexOf(query)
              if (position < 0) continue
              if (matches++ >= offset && items.length < limit) items.push({ path: entry.path, line: i + 1, text: lines[i]!.slice(Math.max(0, position - 100), position + 300) })
            }
          } catch (error) { if (skipped.length < 20) skipped.push({ path: entry.path, reason: (error as Error).message }) }
        }
      }
    }
    await walk(directory)
    return { items, total: matches, complete: !limited, nextOffset: offset + limit < matches ? offset + limit : null,
      ...(limited ? { note: '扫描达到20000个条目，请指定更小目录；total仅为已扫描结果。' } : {}), skipped }
  }
  async write(input: { path: string; body: string }[], confirm: ConfirmFiles, signal?: AbortSignal) {
    if (!input.length || input.length > 50) throw new JotError('INVALID_INPUT', '一次写入 1—50 个明确文件')
    const entries = input.map(entry => ({ body: entry.body, location: this.resolve(entry.path) }))
    const identities = entries.map(e => process.platform === 'win32' ? e.location.absolute.toLowerCase() : e.location.absolute)
    if (new Set(identities).size !== entries.length) throw new JotError('INVALID_INPUT', '写入目标不能重复')
    const existing = new Set<string>()
    for (const { location, body } of entries) {
      textFile(location.path, Buffer.from(body, 'utf8'))
      const stat = await fs.promises.stat(location.absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (stat && !stat.isFile()) throw new JotError('INVALID_INPUT', '目标是目录：' + location.path)
      if (stat) { await this.raw(location); existing.add(location.path) }
    }
    const targets = entries.filter(e => existing.has(e.location.path)).map(e => ({ path: e.location.path, action: 'overwrite' as const }))
    if (targets.length && !await confirm('替换这些文件的完整内容', targets)) throw new JotError('CANCELLED', '用户未同意覆盖，文件未写入')
    const updated: string[] = [], failed: { path: string; message: string }[] = []
    await this.deps.mutate(async () => {
      cancelled(signal)
      for (const { location } of entries) if (!existing.has(location.path) && fs.existsSync(location.absolute)) {
        throw new JotError('CONFLICT', '新建目标已存在，请重新读取并列出覆盖目标：' + location.path)
      }
      for (const { location, body } of entries) {
        try {
          cancelled(signal)
          this.resolve(location.path)
          if (existing.has(location.path)) {
            await this.raw(location)
            await writeFileAtomic(location.absolute, body)
          } else {
            if (location.relative !== undefined && fs.existsSync(this.deps.vault.abs(sidecarPath(location.relative)))) throw new JotError('CONFLICT', '目标已有同名附属属性')
            await fs.promises.mkdir(path.dirname(location.absolute), { recursive: true })
            await fs.promises.writeFile(location.absolute, body, { flag: 'wx' })
          }
          this.notify([location])
          await verifyTextFile(location.absolute, body)
          updated.push(location.path)
        } catch (error) { failed.push({ path: location.path, message: (error as Error).message }) }
      }
    })
    await this.deps.changed()
    return { updated, failed }
  }
  async edit(raw: string, before: string, after: string, confirm: ConfirmFiles, signal?: AbortSignal): Promise<void> {
    const location = this.resolve(raw)
    if (!before) throw new JotError('INVALID_INPUT', '匹配原文不能为空')
    const current = await this.raw(location)
    if (before.length >= current.text.length * 0.8 && !await confirm('替换文件的大部分内容', [{ path: location.path, action: 'overwrite' }])) throw new JotError('CANCELLED', '用户未同意替换，文件未修改')
    await this.deps.mutate(async () => {
      cancelled(signal)
      const { text } = await this.raw(location)
      const first = text.indexOf(before)
      if (first < 0 || text.indexOf(before, first + 1) >= 0) throw new JotError('CONFLICT', '原文未唯一匹配，请重新读取')
      const next = text.slice(0, first) + after + text.slice(first + before.length)
      textFile(location.path, Buffer.from(next, 'utf8'))
      await writeFileAtomic(location.absolute, next)
      this.notify([location])
      await verifyTextFile(location.absolute, next)
    })
    await this.deps.changed()
  }
  async properties(raw: string, patch: Record<string, unknown>, signal?: AbortSignal): Promise<DocMeta> {
    const path = this.path(raw)
    cancelled(signal)
    return this.deps.operations().execute('doc:patchProperties', { path, patch })
  }
  async mkdir(raw: string, name: string, signal?: AbortSignal) {
    if (!name.trim() || name === '.' || name === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) throw new JotError('INVALID_INPUT', '请提供一个有效的子目录名称')
    const location = this.resolve(path.join(this.resolve(raw).absolute, name))
    await this.deps.mutate(async () => {
      cancelled(signal)
      const stat = await fs.promises.stat(location.absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (stat && !stat.isDirectory()) throw new JotError('CONFLICT', '目标已存在且不是目录')
      await fs.promises.mkdir(location.absolute, { recursive: true })
      this.notify([location], 'add')
    })
    await this.deps.changed()
    return { path: location.path }
  }
  async move(raw: string, to: string, signal?: AbortSignal): Promise<MoveResult> {
    const source = this.resolve(raw), target = this.resolve(to)
    assertMovable(this.deps.vault, source)
    if (samePath(source.absolute, target.absolute)) return { path: target.path, paths: [], notUpdated: [] }
    assertMovable(this.deps.vault, target)
    cancelled(signal)
    // 库内容移动继续复用附件组、普通链接维护和界面路径通知。
    if (source.relative && target.relative && /^(content|inbox|ideas)\//.test(source.relative) && /^(content|inbox|ideas)\//.test(target.relative)) {
      return this.deps.operations().execute('content:move', { path: source.relative, targetPath: target.relative })
    }
    if (insidePath(target.absolute, source.absolute)) throw new JotError('INVALID_INPUT', '不能移动到自身的子目录')
    const pairs = [{ from: source, to: target }]
    const stat = await fs.promises.stat(source.absolute)
    if (stat.isFile() && (source.relative !== undefined || target.relative !== undefined) && fs.existsSync(sidecarPath(source.absolute))) {
      pairs.push({ from: this.resolve(sidecarPath(source.absolute), true), to: this.resolve(sidecarPath(target.absolute), true) })
    }
    await this.deps.mutate(async () => {
      cancelled(signal)
      for (const pair of pairs) if (fs.existsSync(pair.to.absolute)) throw new JotError('CONFLICT', '目标文件或目录已存在：' + pair.to.path)
      if (stat.isFile() && !pairs.some(pair => isSidecar(pair.to.path)) && fs.existsSync(sidecarPath(target.absolute))) throw new JotError('CONFLICT', '目标已有同名附属属性')
      const completed: typeof pairs = []
      try {
        for (const pair of pairs) {
          await this.moveEntry(pair.from.absolute, pair.to.absolute)
          completed.push(pair)
        }
      } catch (error) {
        for (const pair of completed.reverse()) await this.moveEntry(pair.to.absolute, pair.from.absolute)
        throw error
      }
      this.notify([source], 'remove'); this.notify([target], 'add')
      await this.deps.moved(pairs.map(pair => ({ from: pair.from.path, to: pair.to.path })))
      if (source.relative !== undefined) this.deps.trashed([source.relative])
    })
    await this.deps.changed()
    return { path: target.path, paths: pairs.map(pair => ({ from: pair.from.path, to: pair.to.path })),
      notUpdated: source.relative !== undefined || target.relative !== undefined ? [{ path: source.path, message: '跨库或系统目录移动未改写已有内容链接，请按需要调整引用。' }] : [] }
  }
  private async moveEntry(from: string, to: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(to), { recursive: true })
    try { await fs.promises.rename(from, to) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await fs.promises.cp(from, to, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
      await fs.promises.rm(from, { recursive: true })
    }
  }
  private async trashTargets(paths: FileLocation[]): Promise<string[]> {
    const targets = new Set<string>()
    const walk = async (absolute: string, display: string): Promise<void> => {
      if (targets.size >= 5000) throw new JotError('INVALID_INPUT', '一次回收最多 5000 个实际条目，请缩小目标范围')
      const stat = await fs.promises.lstat(absolute)
      targets.add(display)
      if (stat.isDirectory()) {
        for (const entry of await fs.promises.readdir(absolute)) await walk(path.join(absolute, entry), display + '/' + entry)
      } else if (!stat.isFile() && !stat.isSymbolicLink()) throw new JotError('INVALID_INPUT', '不支持的文件条目：' + display)
    }
    for (const location of paths) {
      await walk(location.absolute, location.path)
      if (location.relative !== undefined && fs.existsSync(sidecarPath(location.absolute))) targets.add(sidecarPath(location.path))
    }
    return [...targets].sort()
  }
  async trash(input: string[], confirm: ConfirmFiles, signal?: AbortSignal) {
    if (!input.length || input.length > 50) throw new JotError('INVALID_INPUT', '一次回收 1—50 个明确目标')
    const all = input.map(raw => this.resolve(raw))
    for (const location of all) assertMovable(this.deps.vault, location)
    const paths = all.filter((location, i) => !all.some((parent, j) => j < i && samePath(location.absolute, parent.absolute)
      || !samePath(location.absolute, parent.absolute) && insidePath(location.absolute, parent.absolute)))
    const targets = await this.trashTargets(paths)
    if (!await confirm('将这些内容移入回收站', targets.map(path => ({ path, action: 'trash' })))) throw new JotError('CANCELLED', '用户取消了回收，文件未删除')
    const results: { path: string; trashId?: string; recycled?: boolean; error?: string }[] = []
    await this.deps.mutate(async () => {
      cancelled(signal)
      if (JSON.stringify(await this.trashTargets(paths)) !== JSON.stringify(targets)) throw new JotError('CONFLICT', '回收目标列表已变化，请重新列出并确认')
      for (const location of paths) {
        try {
          cancelled(signal)
          const rel = indexedPath(location)
          if (rel) {
            const stat = await fs.promises.stat(location.absolute)
            const result = stat.isDirectory() ? await this.deps.vault.trashFolder(rel) : await this.deps.vault.trash({ path: rel })
            this.deps.trashed([rel])
            results.push({ path: rel, ...result })
          } else {
            await this.deps.operations().trashExternal(location.absolute)
            results.push({ path: location.path, recycled: true })
          }
        } catch (error) { results.push({ path: location.path, error: (error as Error).message }) }
      }
    })
    await this.deps.changed()
    return results
  }
}
