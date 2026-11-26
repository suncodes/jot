import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { ulid } from 'ulid'
import { createAssistantConfiguration, type AssistantConfiguration } from '@shared/capabilities'
import { validateContentDirectory } from '@shared/date-paths'
import { isAppExtensionId } from '@shared/commands'
import { JotError } from '@shared/result'
import { assistantConfiguration } from '../agent/capability-schema'
import type { Doc, DocMeta, Ref, TreeNode, VaultChange, VaultStatus } from '@shared/types'
import { exists, readJson, writeFileAtomic, writeJson } from '../util/fs'
import { activityRange, fileStamp, localIso } from '../util/time'
import { buildMeta, isMarkdown } from './doc'
import { MetadataService, isSidecar, sidecarPath } from './metadata'
import { parseDoc, stringifyDoc } from './frontmatter'
import { PackageFiles } from './package-files'
import { DIRS, FIXED_DIRS, isInContent, isInMeta, isInTemplates, isInUserContent, monthlyPath, normalizeRel, resolveInVault, toRel } from './paths'

const DEFAULT_CONTENT_FOLDERS = ['工作', '生活', '成长', '健康']

/** 写入用途：明确的用户／助手操作与后台流水线分开。 */
export type Actor = 'user' | 'pipeline'

export interface FileEntry {
  path: string
  mtimeMs: number
  size: number
}

const TEXT_EXT = /\.(md|markdown|txt|log|csv|json|ya?ml|xml|ini|conf|tsv)$/i
const BAD_NAME = /[\\/:*?"<>|]/
const WATCH_DEBOUNCE_MS = 200

export const hashText = (text: string): string => 'sha256:' + createHash('sha256').update(text).digest('hex')

export function isTextFile(rel: string): boolean {
  return TEXT_EXT.test(rel)
}

/**
 * 库服务：负责库内文档业务、属性、目录结构及文件监听；通用文件工具复用变更通知。
 * 见 docs/architecture.md。
 */
export class VaultService {
  bundledPluginRoot = path.resolve(import.meta.dirname, '../../resources/plugins')
  readonly skillFiles = new PackageFiles(() => this.abs(DIRS.skills))
  readonly pluginFiles = new PackageFiles(() => this.abs(DIRS.plugins), 'plugin.json')
  readonly appExtensionFiles = new PackageFiles(() => this.abs(DIRS.appExtensions), 'extension.json', isAppExtensionId)
  readonly metadata = new MetadataService(rel => this.abs(rel))
  private maintainLinks: (changes: import('@shared/files').PathChange[]) => Promise<{ path: string; message: string }[]> = async () => []
  setLinkMaintainer(maintain: typeof this.maintainLinks): void { this.maintainLinks = maintain }
  private async updateLinks(changes: import('@shared/files').PathChange[]): Promise<{ path: string; message: string }[]> {
    try { return await this.maintainLinks(changes) }
    catch (error) { return [{ path: changes[0]?.to ?? '', message: '链接维护未完成：' + (error instanceof Error ? error.message : String(error)) }] }
  }
  private root: string | null = null
  private watcher: FSWatcher | null = null
  private pending = new Map<string, VaultChange['kind']>()
  private timer: NodeJS.Timeout | null = null
  private emitter = new EventEmitter()
  /** 当前时间，测试里可以替换 */
  private now: () => Date = () => new Date()

  setClock(now: () => Date): void {
    this.now = now
  }

  get isOpen(): boolean {
    return this.root !== null
  }

  /** 库的绝对路径；没打开时抛出 VAULT_NOT_OPEN */
  get path(): string {
    if (!this.root) throw new JotError('VAULT_NOT_OPEN', '还没有打开库')
    return this.root
  }

  status(): VaultStatus {
    return this.root ? { open: true, path: this.root } : { open: false }
  }

  on(_event: 'changed', listener: (changes: VaultChange[]) => void): () => void {
    this.emitter.on('changed', listener)
    return () => this.emitter.off('changed', listener)
  }

  /** 打开库。create 为 true 时文件夹不存在会新建；固定目录缺失时一律补齐。 */
  async open(dir: string, create: boolean): Promise<{ path: string }> {
    if (!dir || !path.isAbsolute(dir)) throw new JotError('INVALID_INPUT', '库的位置必须是完整路径')
    const root = path.resolve(dir)
    if (!(await exists(root))) {
      if (!create) throw new JotError('NOT_FOUND', `文件夹不存在：${root}`)
      await fs.promises.mkdir(root, { recursive: true })
    } else if (!(await fs.promises.stat(root)).isDirectory()) {
      throw new JotError('INVALID_INPUT', `不是文件夹：${root}`)
    }
    // 本轮采用新库结构；旧库必须先显式整理，不能打开后混用两套目录。
    const legacy = [] as string[]
    for (const name of ['notes', 'files', 'projects']) {
      if (await exists(path.join(root, name))) legacy.push(name)
    }
    if (legacy.length) throw new JotError('INVALID_INPUT', '请先将旧目录整理到 content/：' + legacy.join('、'))
    const configFile = path.join(root, DIRS.meta, 'config.json')
    const saved = await readJson<{ version?: number }>(configFile, {})
    if (saved.version !== undefined && saved.version !== 3) throw new JotError('INVALID_INPUT', '此库仍使用旧存储格式，请完成文件优先切换后再打开；本次未修改内容')
    for (const d of FIXED_DIRS) await fs.promises.mkdir(path.join(root, d), { recursive: true })
    // 只为全新库创建默认文件夹，后续由真实目录决定，不从旧名称表补造目录。
    if (saved.version === undefined) for (const name of DEFAULT_CONTENT_FOLDERS) await fs.promises.mkdir(path.join(root, DIRS.content, name), { recursive: true })
    if (saved.version !== 3) await writeJson(configFile, { version: 3 })
    await this.close()
    this.root = root
    return { path: root }
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    await this.watcher?.close()
    this.watcher = null
    this.root = null
  }

  /** 应用配置专用入口；普通文档写入仍不能访问 .jot。 */
  async getAssistantConfiguration(): Promise<AssistantConfiguration> {
    try {
      const text = await fs.promises.readFile(this.abs(DIRS.meta + '/assistant.json'), 'utf8')
      return assistantConfiguration.parse(JSON.parse(text))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createAssistantConfiguration()
      if (error instanceof JotError) throw error
      throw new JotError('INVALID_INPUT', '智能体配置无法读取，请检查 .jot/assistant.json 后重试')
    }
  }

  async saveAssistantConfiguration(config: AssistantConfiguration): Promise<void> {
    await writeJson(this.abs(DIRS.meta + '/assistant.json'), assistantConfiguration.parse(config))
  }

  /** 库内相对路径转绝对路径，并检查不越界 */
  abs(rel: string): string {
    return resolveInVault(this.path, rel)
  }

  rel(abs: string): string {
    return toRel(this.path, abs)
  }

  // ---------- 监听 ----------

  /** 开始监听库里的文件变化（不含 .jot 和其他以点开头的目录）。200 毫秒内的多次变化合并成一次通知。 */
  startWatching(): void {
    const root = this.path
    if (this.watcher) return
    this.watcher = watch(root, {
      ignoreInitial: true,
      ignored: (p) => p !== root && (isInTemplates(toRel(root, p)) || path.relative(root, p).split(path.sep).some((seg) => seg.startsWith('.'))),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })
    const queue = (kind: VaultChange['kind']) => (abs: string) => {
      if (this.root !== root) return
      this.note({ kind, path: toRel(root, abs) })
    }
    this.watcher.on('add', queue('add')).on('change', queue('change')).on('unlink', queue('remove')).on('addDir', queue('add')).on('unlinkDir', queue('remove'))
  }

  /** 记下一处变化，稍后合并通知。软件自己写文件后也调用它，不必等监听发现。 */
  private note(change: VaultChange): void {
    const prev = this.pending.get(change.path)
    // 同一个文件先删后加算作修改
    const kind = prev === 'remove' && change.kind === 'add' ? 'change' : prev === 'add' && change.kind === 'change' ? 'add' : change.kind
    this.pending.set(change.path, kind)
    this.timer ??= setTimeout(() => this.flush(), WATCH_DEBOUNCE_MS)
  }

  /** 立即发出已记下的变化 */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.size === 0) return
    const changes = [...this.pending].map(([p, kind]) => ({ kind, path: p }))
    this.pending.clear()
    this.emitter.emit('changed', changes)
  }

  /** 外部文件操作完成后主动通知库变更，不等待文件监听时序。 */
  notifyChanges(...changes: VaultChange[]): void {
    for (const c of changes) this.note(c)
    this.flush()
  }

  // ---------- 读 ----------

  private pathOf(ref: Ref): string {
    this.abs(ref.path)
    return normalizeRel(ref.path)
  }

  private async readText(rel: string): Promise<{ text: string; stat: fs.Stats }> {
    const abs = this.abs(rel)
    if (isInMeta(rel)) throw new JotError('PATH_OUTSIDE_VAULT', '不能访问软件数据目录')
    try {
      const stat = await fs.promises.stat(abs)
      if (!stat.isFile()) throw new JotError('NOT_FOUND', `不是文件：${rel}`)
      return { text: await fs.promises.readFile(abs, 'utf8'), stat }
    } catch (e) {
      if (e instanceof JotError) throw e
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new JotError('NOT_FOUND', `文件不存在：${rel}`)
      throw new JotError('IO_ERROR', `读取失败：${(e as Error).message}`)
    }
  }

  async read(ref: Ref): Promise<Doc> {
    const rel = this.pathOf(ref)
    if (isInMeta(rel) || isSidecar(rel)) throw new JotError('PATH_OUTSIDE_VAULT', '请通过所属文件访问属性')
    const stat = await fs.promises.stat(this.abs(rel)).catch(() => null)
    if (!stat?.isFile()) throw new JotError('NOT_FOUND', '文件不存在：' + rel)
    const text = isTextFile(rel) ? await fs.promises.readFile(this.abs(rel), 'utf8') : ''
    const properties = await this.metadata.read(rel, text)
    const parsed = isMarkdown(rel) && !properties.attachment ? parseDoc(text)
      : { data: properties.data, body: text, bodyStartLine: 1, hasFrontmatter: false, invalid: properties.invalid }
    const meta = buildMeta(rel, { ...parsed, data: properties.data, invalid: properties.invalid }, stat)
    if (properties.sidecar && properties.sidecar.mtimeMs > stat.mtimeMs) meta.modified = new Date(properties.sidecar.mtimeMs).toISOString()
    const attachment = properties.attachment
    return { ...meta, size: stat.size, ...(attachment ? {
      type: 'file' as const, role: 'source' as const, title: path.posix.basename(rel), generatedByAi: false, sourcePath: undefined, start: undefined, end: undefined,
    } : {}), body: parsed.body, hash: hashText(text), bodyStartLine: parsed.bodyStartLine, editable: isTextFile(rel) }
  }

  /** 读原始文本，给索引用 */
  async readRaw(rel: string): Promise<{ text: string; mtimeMs: number; size: number; birthtime: Date; mtime: Date; properties: import('./metadata').FileProperties }> {
    const { text, stat } = await this.readText(rel)
    return { text, mtimeMs: stat.mtimeMs, size: stat.size, birthtime: stat.birthtime, mtime: stat.mtime, properties: await this.metadata.read(rel, text) }
  }

  /** 列出库里的全部文件（不含 .jot 和以点开头的目录） */
  async listFiles(directory = ''): Promise<FileEntry[]> {
    const root = this.path
    const out: FileEntry[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.') || isInTemplates(toRel(root, path.join(dir, e.name)))) continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) await walk(abs)
        else if (e.isFile() && !isSidecar(e.name)) {
          const stat = await fs.promises.stat(abs).catch(() => null)
          if (stat) out.push({ path: toRel(root, abs), mtimeMs: stat.mtimeMs, size: stat.size })
        }
      }
    }
    if (isInMeta(directory)) throw new JotError('PATH_OUTSIDE_VAULT', '不能索引软件数据目录')
    if (isInTemplates(directory)) return out
    await walk(this.abs(directory))
    return out
  }

  /** 目录树（不含 .jot/）。目录在前，按名称排序。 */
  async tree(dir = ''): Promise<TreeNode[]> {
    if (isInMeta(dir)) throw new JotError('PATH_OUTSIDE_VAULT', '不能访问软件数据目录')
    const base = this.abs(dir)
    const walk = async (absDir: string): Promise<TreeNode[]> => {
      const entries = await fs.promises.readdir(absDir, { withFileTypes: true }).catch(() => [])
      const nodes: TreeNode[] = []
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const abs = path.join(absDir, e.name)
        const rel = this.rel(abs)
        if (!normalizeRel(dir) && isInTemplates(rel)) continue
        if (e.isDirectory()) nodes.push({ name: e.name, path: rel, kind: 'dir', children: await walk(abs) })
        else if (e.isFile() && !isSidecar(e.name)) nodes.push({ name: e.name, path: rel, kind: 'file' })
      }
      return nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN') : a.kind === 'dir' ? -1 : 1))
    }
    return walk(base)
  }

  async directories(parentPath = DIRS.content as string, recursive = false): Promise<import('@shared/files').DirectoryItem[]> {
    this.abs(parentPath)
    const nodes = await this.tree(parentPath)
    const output: import('@shared/files').DirectoryItem[] = []
    const visit = (entries: TreeNode[]) => {
      for (const entry of entries.filter(node => node.kind === 'dir')) {
        output.push({ path: entry.path, name: entry.name, hasChildren: entry.children?.some(child => child.kind === 'dir') ?? false })
        if (recursive) visit(entry.children ?? [])
      }
    }
    visit(nodes)
    return output
  }

  // ---------- 写 ----------

  /**
   * 写入权限（见架构文档 4.1）：
   * 用户可明确编辑资料；旧业务根目录不再接受写入。
   * 自动正文生成默认写 wiki/、journal/；重新生成现有摘要由 writeGenerated 校验目标用途。
   */
  private assertWritable(rel: string, actor: Actor, what: 'body' | 'frontmatter' | 'file'): void {
    if (!rel || isInMeta(rel)) throw new JotError('WRITE_DENIED', '不能写入软件数据目录')
    if (/^(notes|files|projects)(\/|$)/i.test(rel)) throw new JotError('WRITE_DENIED', '旧目录已停用，请使用 content/ 或 inbox/')
    if (isSidecar(rel)) throw new JotError('WRITE_DENIED', '请通过所属文件修改属性')
    if (actor === 'pipeline' && what !== 'frontmatter' && this.metadata.isAttachment(rel) && isInUserContent(rel)) throw new JotError('WRITE_DENIED', '自动处理不能覆盖原件')
    if (actor === 'user') return
    const under = (dir: string) => rel.startsWith(dir + '/')
    if (under(DIRS.wiki) || under(DIRS.journal)) return
    if (what === 'frontmatter' && isInUserContent(rel)) return
    throw new JotError('WRITE_DENIED', `流水线不能修改这个位置：${rel}`)
  }

  /** 用户从系统保存窗口选择库内目标时，导出仍遵守库写入边界。 */
  async writeExport(rel: string, text: string): Promise<void> {
    this.assertWritable(rel, 'user', 'file')
    if (!/\.(md|jsonl)$/i.test(rel)) throw new JotError('INVALID_INPUT', '不支持的导出格式')
    const absolute = this.abs(rel)
    const previous = await fs.promises.lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (previous?.isSymbolicLink() || previous && !previous.isFile()) throw new JotError('INVALID_INPUT', '请选择普通文件作为导出目标')
    await writeFileAtomic(absolute, text)
    this.notifyChanges({ kind: previous ? 'change' : 'add', path: normalizeRel(rel) })
  }

  /** 在某个目录下找一个还没被占用的路径：名称重复时加序号 */
  async freePath(dir: string, base: string, ext: string): Promise<string> {
    return this.uniquePath(dir, base, ext)
  }

  /** 按需计算内容 hash；等待句柄关闭，避免 Windows 的原子替换被读句柄阻挡。 */
  async hashFile(rel: string): Promise<string> { return this.hashAbsolute(this.abs(rel)) }

  private async hashAbsolute(absolute: string): Promise<string> {
    const hash = createHash('sha256')
    const handle = await fs.promises.open(absolute, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      return 'sha256:' + hash.digest('hex')
    } finally {
      await handle.close()
    }
  }
  /** 复制到明确目录；未指定时进入当月 inbox，原件不覆盖、字节不改动。 */
  async importFile(absPath: string, toDir?: string): Promise<{ path: string }> {
    const src = path.resolve(absPath)
    if (isSidecar(src)) throw new JotError('INVALID_INPUT', '附属属性请连同所属文件管理')
    const stat = await fs.promises.stat(src).catch(() => null)
    if (!stat) throw new JotError('NOT_FOUND', `文件不存在：${src}`)
    if (!stat.isFile()) throw new JotError('INVALID_INPUT', '只能放入文件，不能放入文件夹')
    const inside = path.relative(this.path, src)
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) throw new JotError('INVALID_INPUT', '这个文件已经在库里')
    const created = localIso(this.now())
    const dir = this.newContentDirectory(toDir, created)
    this.folderArea(dir)
    await fs.promises.mkdir(this.abs(dir), { recursive: true })
    const ext = path.extname(src)
    const rel = await this.uniquePath(dir, path.basename(src, ext), ext)
    try {
      await fs.promises.copyFile(src, this.abs(rel))
    } catch (e) {
      throw new JotError('IO_ERROR', `复制失败：${(e as Error).message}`)
    }
    await this.metadata.markImported(rel, created)
    this.notifyChanges({ kind: 'add', path: rel })
    return { path: rel }
  }

  /**
   * 写入一页 AI 生成的内容（摘要页、日总结）。页面已存在时保留未知属性与创建时间，只换生成相关的属性和正文。
   */
  async writeGenerated(rel: string, data: Record<string, unknown>, body: string): Promise<DocMeta> {
    this.assertWritable(rel, 'pipeline', 'frontmatter')
    const abs = this.abs(rel)
    let prev: Record<string, unknown> = {}
    const existed = await exists(abs)
    if (existed) {
      const current = parseDoc(await fs.promises.readFile(abs, 'utf8'))
      if (current.invalid) throw new JotError('INVALID_INPUT', '生成目标的 YAML 属性无效，请先修正')
      prev = current.data
    }
    // 用户移出的摘要仍可主动重做；不得把普通笔记或附件变成自动生成目标。
    if (isInUserContent(rel) && (data.type !== 'source-summary' || prev.type !== 'source-summary' || this.metadata.isAttachment(rel))) {
      throw new JotError('WRITE_DENIED', '自动正文生成只能替换已有摘要，不能覆盖笔记或原件')
    }
    const merged = { created: localIso(this.now()), ...prev, ...data }
    try {
      await writeFileAtomic(abs, stringifyDoc(merged, body))
    } catch (e) {
      throw new JotError('IO_ERROR', `保存失败：${(e as Error).message}`)
    }
    const meta = buildMeta(rel, { data: merged, body, bodyStartLine: 1, hasFrontmatter: true, invalid: false }, await fs.promises.stat(abs))
    this.notifyChanges({ kind: existed ? 'change' : 'add', path: rel })
    return meta
  }

  private async uniquePath(dir: string, base: string, ext: string): Promise<string> {
    for (let i = 1; ; i++) {
      const rel = `${dir}/${i === 1 ? base : `${base} ${i}`}${ext}`
      if (!(await exists(this.abs(rel))) && !(await exists(this.abs(sidecarPath(rel))))) return rel
    }
  }

  private async writeNew(rel: string, data: Record<string, unknown>, body: string): Promise<DocMeta> {
    this.assertWritable(rel, 'user', 'file')
    const abs = this.abs(rel)
    const text = stringifyDoc(data, body)
    try {
      await writeFileAtomic(abs, text)
    } catch (e) {
      throw new JotError('IO_ERROR', `保存失败：${(e as Error).message}`)
    }
    const stat = await fs.promises.stat(abs)
    const meta = buildMeta(rel, { data, body, bodyStartLine: 1, hasFrontmatter: true, invalid: false }, stat)
    this.notifyChanges({ kind: 'add', path: rel })
    return meta
  }

  /** 保存一条想法：ideas/年/月/ 下一条一个文件，文件名是记录时间。 */
  async createIdea(input: { text: string; source: string; at?: Date; tags?: string[] }): Promise<DocMeta> {
    const text = input.text.trim()
    if (!text) throw new JotError('INVALID_INPUT', '内容不能为空')
    const at = input.at ?? this.now()
    const dir = monthlyPath(DIRS.ideas, localIso(at))
    const rel = await this.uniquePath(dir, fileStamp(at), '.md')
    const tags = input.tags?.length ? { tags: input.tags } : {}
    return this.writeNew(rel, { type: 'idea', created: localIso(at), ...tags }, text + '\n')
  }

  /** 新建文件夹 */
  async createFolder(parent: string, name: string): Promise<{ path: string }> {
    this.abs(parent)
    const base = normalizeRel(parent)
    this.folderArea(base)
    const title = this.folderName(name)
    const stat = await fs.promises.lstat(this.abs(base)).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new JotError('NOT_FOUND', '目标目录不存在')
    const rel = base + '/' + title
    if (await exists(this.abs(rel))) throw new JotError('CONFLICT', '已经有同名的文件或文件夹')
    await fs.promises.mkdir(this.abs(rel))
    this.emitter.emit('changed', [])
    return { path: rel }
  }

  /** 补记一件事：ideas/年/月/ 按发生日期分层，文件名用开始时间。 */
  async createLog(input: { text: string; start: string; end: string }): Promise<DocMeta> {
    const text = input.text.trim()
    if (!text) throw new JotError('INVALID_INPUT', '内容不能为空')
    const { start, end } = activityRange(input.start, input.end)
    const dir = monthlyPath(DIRS.ideas, start)
    const rel = await this.uniquePath(dir, start.length === 10 ? start : fileStamp(new Date(start)), '.md')
    return this.writeNew(rel, { type: 'log', created: localIso(this.now()), start, end }, text + '\n')
  }

  /** 按明确路径新建文本，不覆盖已存在文件，不要求永久 ID。 */
  async createText(raw: string, text: string): Promise<Doc> {
    this.abs(raw)
    const rel = normalizeRel(raw)
    this.assertWritable(rel, 'user', 'file')
    if (!isTextFile(rel)) throw new JotError('UNSUPPORTED_FORMAT', '只能新建文本文件')
    this.folderName(path.posix.basename(rel))
    if (await exists(this.abs(sidecarPath(rel)))) throw new JotError('CONFLICT', '目标已有同名附属属性，请先检查：' + rel)
    const absolute = this.abs(rel)
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
    let handle: fs.promises.FileHandle
    try { handle = await fs.promises.open(absolute, 'wx') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new JotError('CONFLICT', '目标已存在，请先读取：' + rel)
      throw error
    }
    try { await handle.writeFile(text, 'utf8') }
    catch (error) { await handle.close(); await fs.promises.rm(absolute, { force: true }); throw error }
    await handle.close()
    this.notifyChanges({ kind: 'add', path: rel })
    return this.read({ path: rel })
  }

  async contentDirectoryExists(rel: string): Promise<boolean> {
    validateContentDirectory(rel)
    const absolute = resolveInVault(this.abs(DIRS.content), rel === DIRS.content ? '' : rel.slice(DIRS.content.length + 1))
    try {
      const stat = await fs.promises.lstat(absolute)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new JotError('CONFLICT', '目录位置已被文件或链接占用：' + rel)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      if (error instanceof JotError) throw error
      throw new JotError('IO_ERROR', '无法访问目录：' + rel)
    }
  }

  async ensureContentDirectories(directories: string[]): Promise<void> {
    try {
      for (const rel of directories) {
        validateContentDirectory(rel)
        const absolute = resolveInVault(this.abs(DIRS.content), rel === DIRS.content ? '' : rel.slice(DIRS.content.length + 1))
        await fs.promises.mkdir(absolute, { recursive: true })
      }
    } catch (error) {
      if (error instanceof JotError) throw error
      throw new JotError('IO_ERROR', '内容目录创建失败：' + (error as Error).message)
    } finally { this.emitter.emit('changed', []) }
  }

  async noteTargetExists(raw: string): Promise<boolean> {
    this.abs(raw)
    const rel = normalizeRel(raw)
    if (!isInContent(rel) || !isMarkdown(rel)) throw new JotError('INVALID_INPUT', '日记目标必须是 content/ 下的 Markdown 文件')
    this.assertWritable(rel, 'user', 'file')
    const absolute = resolveInVault(this.abs(DIRS.content), rel.slice(DIRS.content.length + 1))
    try {
      const stat = await fs.promises.lstat(absolute)
      if (!stat.isFile()) throw new JotError('CONFLICT', '日记目标已被文件夹或链接占用：' + rel)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      if (error instanceof JotError) throw error
      throw new JotError('IO_ERROR', '无法访问日记目标：' + rel)
    }
  }

  async createOrOpenNote(rel: string, prepare: () => Promise<string>): Promise<{ path: string; created: boolean }> {
    if (await this.noteTargetExists(rel)) return { path: rel, created: false }
    const text = await prepare()
    if (await this.noteTargetExists(rel)) return { path: rel, created: false }
    try { await this.createText(rel, text) }
    catch (error) {
      if (error instanceof JotError && error.code === 'CONFLICT' && await this.noteTargetExists(rel)) return { path: rel, created: false }
      if (error instanceof JotError) throw error
      throw new JotError('IO_ERROR', '无法创建日记：' + rel)
    }
    return { path: rel, created: true }
  }

  private newContentDirectory(input: string | undefined, created: string): string {
    if (input !== undefined) this.abs(input)
    return normalizeRel(input ?? '') || monthlyPath(DIRS.inbox, created)
  }

  async createNote(input: { dir?: string; title: string; body?: string }): Promise<DocMeta> {
    const created = localIso(this.now())
    const dir = this.newContentDirectory(input.dir, created)
    this.folderArea(dir)
    const title = input.title.trim()
    if (!title || BAD_NAME.test(title)) throw new JotError('INVALID_INPUT', '名称不能为空，也不能包含 \\ / : * ? " < > |')
    this.assertWritable(`${dir}/x`, 'user', 'file')
    await fs.promises.mkdir(this.abs(dir), { recursive: true })
    const rel = await this.uniquePath(dir, title, '.md')
    return this.writeNew(rel, { type: 'note', created }, input.body ?? '')
  }

  /** 保存正文。baseHash 是打开文件时的指纹，磁盘上的内容已经不同则返回 CONFLICT。 */
  async saveBody(ref: Ref, body: string, baseHash: string, actor: Actor = 'user'): Promise<{ hash: string }> {
    const rel = this.pathOf(ref)
    this.assertWritable(rel, actor, 'body')
    if (!isTextFile(rel)) throw new JotError('UNSUPPORTED_FORMAT', '这种文件不能在软件里编辑')
    const { text } = await this.readText(rel)
    if (hashText(text) !== baseHash) throw new JotError('CONFLICT', '文件已经在别处被修改')
    const next = isMarkdown(rel) && !this.metadata.isAttachment(rel) ? this.replaceBody(text, body) : body
    if (next === text) return { hash: baseHash }
    try {
      await writeFileAtomic(this.abs(rel), next)
    } catch (e) {
      throw new JotError('IO_ERROR', `保存失败：${(e as Error).message}`)
    }
    this.notifyChanges({ kind: 'change', path: rel })
    return { hash: hashText(next) }
  }

  /** 只换正文，文件头原样保留（不重新排版你手写的属性） */
  private replaceBody(text: string, body: string): string {
    const parsed = parseDoc(text)
    const src = text.replace(/^﻿/, '')
    return src.slice(0, src.length - parsed.body.length) + body
  }

  /** 属性统一写 frontmatter 或附件附属文件，不改原件字节、不补永久 ID。 */
  async patchFrontmatter(ref: Ref, patch: Record<string, unknown>, actor: Actor): Promise<DocMeta> {
    const rel = this.pathOf(ref)
    this.assertWritable(rel, actor, 'frontmatter')
    if (!(await fs.promises.stat(this.abs(rel)).catch(() => null))?.isFile()) throw new JotError('NOT_FOUND', '文件不存在：' + rel)
    await this.metadata.patch(rel, patch)
    this.notifyChanges({ kind: 'change', path: rel })
    return this.read({ path: rel })
  }

  async patchBatch(patches: { path: string; patch: Record<string, unknown> }[]): Promise<DocMeta[]> {
    const updated: DocMeta[] = []
    for (const entry of patches) updated.push(await this.patchFrontmatter({ path: entry.path }, entry.patch, 'user'))
    return updated
  }

  async getProperties(rel: string): Promise<import('@shared/files').PropertyDocument> {
    const doc = await this.read({ path: rel })
    return { path: rel, data: doc.properties ?? {}, attachment: doc.type === 'file', invalid: doc.invalidProperties ?? false }
  }

  /** 助手等路径调用使用临时原文匹配，不建立来源版本或历史正文仓库。 */
  async editText(rel: string, before: string, after: string): Promise<void> {
    this.assertWritable(rel, 'user', 'body')
    if (!isTextFile(rel)) throw new JotError('UNSUPPORTED_FORMAT', '暂不支持编辑这种格式')
    if (!before) throw new JotError('INVALID_INPUT', '匹配原文不能为空')
    const raw = await this.readText(rel)
    const first = raw.text.indexOf(before)
    if (first < 0 || raw.text.indexOf(before, first + 1) >= 0) throw new JotError('CONFLICT', '原文未唯一匹配，请重新读取')
    await writeFileAtomic(this.abs(rel), raw.text.slice(0, first) + after + raw.text.slice(first + before.length))
    this.notifyChanges({ kind: 'change', path: rel })
  }

  async saveCurrentBody(rel: string, body: string, expectedBody?: string): Promise<{ hash: string }> {
    const current = await this.read({ path: rel })
    if (expectedBody !== undefined && current.body !== expectedBody) throw new JotError('CONFLICT', '文件正文已经变化，请重新读取')
    return this.saveBody({ path: rel }, body, current.hash)
  }

  async rename(ref: Ref, newName: string): Promise<DocMeta> {
    const rel = this.pathOf(ref)
    let name = newName.trim()
    if (!name || BAD_NAME.test(name)) throw new JotError('INVALID_INPUT', '名称不能为空，也不能包含 \\ / : * ? " < > |')
    const ext = path.posix.extname(rel)
    if (path.posix.extname(name).toLowerCase() !== ext.toLowerCase()) name += ext
    return this.moveTo(rel, path.posix.join(path.posix.dirname(rel), name))
  }

  async move(ref: Ref, toDir: string): Promise<DocMeta> {
    const rel = this.pathOf(ref)
    this.abs(toDir)
    this.folderArea(normalizeRel(toDir))
    return this.moveTo(rel, path.posix.join(normalizeRel(toDir), path.posix.basename(rel)))
  }

  private async moveTo(from: string, to: string): Promise<DocMeta> {
    this.assertWritable(from, 'user', 'file')
    this.assertWritable(to, 'user', 'file')
    const changes = [{ from, to }]
    if (await exists(this.abs(sidecarPath(from)))) changes.push({ from: sidecarPath(from), to: sidecarPath(to) })
    if (from === to) return this.read({ path: to })
    for (const change of changes) {
      if (await exists(this.abs(change.to)) && change.from.toLowerCase() !== change.to.toLowerCase()) throw new JotError('CONFLICT', '目标文件或附属属性已存在')
    }
    if (!changes.some(change => isSidecar(change.from)) && await exists(this.abs(sidecarPath(to)))) throw new JotError('CONFLICT', '目标已有同名附属属性')
    if (!(await fs.promises.stat(this.abs(from)).catch(() => null))?.isFile()) throw new JotError('NOT_FOUND', '文件不存在：' + from)
    await fs.promises.mkdir(path.dirname(this.abs(to)), { recursive: true })
    const moved: typeof changes = []
    try {
      for (const change of changes) {
        await fs.promises.rename(this.abs(change.from), this.abs(change.to))
        moved.push(change)
      }
    } catch (error) {
      for (const change of moved.reverse()) await fs.promises.rename(this.abs(change.to), this.abs(change.from))
      throw error
    }
    const notUpdated = await this.updateLinks(changes)
    this.notifyChanges(...changes.flatMap(change => [{ kind: 'remove' as const, path: change.from }, { kind: 'add' as const, path: change.to }]))
    return { ...await this.read({ path: to }), notUpdated }
  }

  async movePath(from: string, targetPath: string): Promise<import('@shared/files').MoveResult> {
    this.abs(from); this.abs(targetPath)
    from = normalizeRel(from); targetPath = normalizeRel(targetPath)
    const stat = await fs.promises.lstat(this.abs(from)).catch(() => null)
    if (!stat) throw new JotError('NOT_FOUND', '目标不存在：' + from)
    this.folderName(path.posix.basename(targetPath))
    this.folderArea(path.posix.dirname(targetPath))
    if (stat.isDirectory()) return this.moveFolder(from, path.posix.dirname(targetPath), path.posix.basename(targetPath))
    const hasSidecar = await exists(this.abs(sidecarPath(from)))
    const doc = await this.moveTo(from, targetPath)
    return { path: doc.path, paths: [{ from, to: targetPath }, ...(hasSidecar ? [{ from: sidecarPath(from), to: sidecarPath(targetPath) }] : [])], notUpdated: doc.notUpdated ?? [] }
  }

  /** 文件及附属属性一组进入回收，删除不改写其他文件中的链接。 */
  async trash(ref: Ref): Promise<{ trashId: string }> {
    return this.trashMany([this.pathOf(ref)])
  }

  async trashMany(paths: string[]): Promise<{ trashId: string }> {
    for (const rel of paths) this.assertWritable(normalizeRel(rel), 'user', 'file')
    const group = new Set(paths.map(normalizeRel))
    for (const rel of [...group]) if (await exists(this.abs(sidecarPath(rel)))) group.add(sidecarPath(rel))
    const entries = [...group].map((rel, i) => ({

      originalPath: normalizeRel(rel), storedName: i + '-' + path.posix.basename(rel),
    }))
    if (!entries.length) throw new JotError('INVALID_INPUT', '没有可删除的文件')
    // 所有目标先校验；目录不通过这个接口删除。
    for (const e of entries) {
      if (!isSidecar(e.originalPath)) this.assertWritable(e.originalPath, 'user', 'file')
      const stat = await fs.promises.stat(this.abs(e.originalPath)).catch(() => null)
      if (!stat?.isFile()) throw new JotError('NOT_FOUND', '文件不存在：' + e.originalPath)
    }
    const { trashId, dir, deletedAt } = await this.newTrashDirectory()
    const moved: typeof entries = []
    try {
      for (const e of entries) {
        await fs.promises.rename(this.abs(e.originalPath), path.join(dir, e.storedName))
        moved.push(e)
      }
      await writeJson(path.join(dir, 'meta.json'), { originalPath: entries[0]!.originalPath, deletedAt, entries })
    } catch (error) {
      for (const e of moved.reverse()) await fs.promises.rename(path.join(dir, e.storedName), this.abs(e.originalPath))
      await this.removeTrashDirectory(dir)
      throw error
    }
    this.notifyChanges(...entries.map((e) => ({ kind: 'remove' as const, path: e.originalPath })))
    return { trashId }
  }

  private async newTrashDirectory(): Promise<{ trashId: string; dir: string; deletedAt: string }> {
    const deletedAt = localIso(this.now()), trashId = ulid()
    const dir = this.abs(monthlyPath(DIRS.trash, deletedAt) + '/' + trashId)
    await fs.promises.mkdir(dir, { recursive: true })
    return { trashId, dir, deletedAt }
  }

  /** 编号保持独立；直接枚举固定三层，恢复不依赖数据库或当前月份。 */
  private async trashDirectories(): Promise<{ trashId: string; dir: string }[]> {
    const entries: { trashId: string; dir: string }[] = []
    const root = this.abs(DIRS.trash)
    for (const year of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (!year.isDirectory() || year.isSymbolicLink()) continue
      if (/^[0-9A-Z]{26}$/.test(year.name)) throw new JotError('INVALID_INPUT', '发现旧平铺回收项，请先备份并整理到删除年月目录；不会自动隐藏或删除')
      if (!/^\d{4}$/.test(year.name)) continue
      const yearPath = DIRS.trash + '/' + year.name
      for (const month of await fs.promises.readdir(this.abs(yearPath), { withFileTypes: true })) {
        if (!month.isDirectory() || month.isSymbolicLink() || !/^(0[1-9]|1[0-2])$/.test(month.name)) continue
        const monthPath = yearPath + '/' + month.name
        for (const item of await fs.promises.readdir(this.abs(monthPath), { withFileTypes: true })) {
          if (item.isDirectory() && !item.isSymbolicLink() && /^[0-9A-Z]{26}$/.test(item.name)) {
            entries.push({ trashId: item.name, dir: this.abs(monthPath + '/' + item.name) })
          }
        }
      }
    }
    return entries
  }

  private async trashDirectory(trashId: string, directories?: { trashId: string; dir: string }[]): Promise<string> {
    if (!/^[0-9A-Z]{26}$/.test(trashId)) throw new JotError('INVALID_INPUT', '无效的回收编号')
    const matches = (directories ?? await this.trashDirectories()).filter(item => item.trashId === trashId)
    if (!matches.length) throw new JotError('NOT_FOUND', '回收目录里没有这一项')
    if (matches.length > 1) throw new JotError('CONFLICT', '回收编号重复，请先检查回收目录')
    return matches[0]!.dir
  }

  private async trashMeta(dir: string): Promise<{ kind?: 'directory'; members?: string[]; originalPath: string; deletedAt: string; entries: { originalPath: string; storedName: string }[] }> {
    const meta = await readJson<{ kind?: 'directory'; members?: string[]; originalPath?: string; deletedAt?: string; entries?: { originalPath: string; storedName: string }[] }>(
      path.join(dir, 'meta.json'), {},
    )
    if (!meta.originalPath) throw new JotError('NOT_FOUND', '回收目录里没有这一项')
    const entries = meta.entries ?? []
    if (!entries.length) throw new JotError('INVALID_INPUT', '回收记录不完整')
    for (const e of entries) {
      if (!e.storedName || /[\\/]/.test(e.storedName) || e.storedName === '.' || e.storedName === '..') throw new JotError('INVALID_INPUT', '回收记录路径无效')
      if (!isSidecar(e.originalPath)) this.assertWritable(e.originalPath, 'user', 'file')
      this.abs(e.originalPath)
    }
    if (new Set(entries.map((e) => e.storedName.toLowerCase())).size !== entries.length) throw new JotError('INVALID_INPUT', '回收记录存储名重复')
    if (meta.kind === 'directory') {
      this.managedFolder(meta.originalPath)
      if (entries[0]!.originalPath !== meta.originalPath || !meta.members) throw new JotError('INVALID_INPUT', '目录回收记录无效')
      for (const member of meta.members) { this.abs(member); if (normalizeRel(member) !== member || !member.startsWith(meta.originalPath + '/')) throw new JotError('INVALID_INPUT', '目录回收记录无效') }
    }
    return { kind: meta.kind, members: meta.members, originalPath: meta.originalPath, deletedAt: meta.deletedAt ?? '', entries }
  }

  async trashList(page: { limit?: number; offset?: number } = {}): Promise<import('@shared/types').Paged<import('@shared/types').TrashItem>> {
    const items: import('@shared/types').TrashItem[] = []
    for (const { trashId, dir } of await this.trashDirectories()) {
      if (!(await exists(path.join(dir, 'meta.json')))) continue
      const meta = await this.trashMeta(dir)
      items.push({ trashId, originalPath: meta.originalPath, kind: meta.kind, paths: meta.kind === 'directory' ? [...(meta.members ?? []), ...meta.entries.slice(1).map((e) => e.originalPath)] : meta.entries.map((e) => e.originalPath), deletedAt: meta.deletedAt })
    }
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || b.trashId.localeCompare(a.trashId))
    return { total: items.length, items: items.slice(page.offset ?? 0, (page.offset ?? 0) + (page.limit ?? 30)) }
  }

  async restoreGroup(trashId: string): Promise<{ doc: DocMeta; paths: { from: string; to: string }[] }> {
    const dir = await this.trashDirectory(trashId)
    const meta = await this.trashMeta(dir)
    if (meta.kind === 'directory') throw new JotError('INVALID_INPUT', '请使用目录恢复')
    const restored: { from: string; to: string; storedName: string }[] = []
    const reserved = new Set<string>()
    const planned: typeof restored = []
    for (const e of meta.entries.filter(entry => !isSidecar(entry.originalPath))) {
      if (!(await exists(path.join(dir, e.storedName)))) throw new JotError('NOT_FOUND', '回收文件缺失：' + e.originalPath)
      const ext = path.posix.extname(e.originalPath)
      const base = path.posix.basename(e.originalPath, ext)
      let to = e.originalPath
      let n = 1
      while (reserved.has(to.toLowerCase()) || reserved.has(sidecarPath(to).toLowerCase()) || await exists(this.abs(to)) || await exists(this.abs(sidecarPath(to)))) {
        to = path.posix.join(path.posix.dirname(e.originalPath), base + ' ' + ++n + ext)
      }
      reserved.add(to.toLowerCase())
      reserved.add(sidecarPath(to).toLowerCase())
      planned.push({ from: e.originalPath, to, storedName: e.storedName })
      const properties = meta.entries.find(entry => entry.originalPath === sidecarPath(e.originalPath))
      if (properties) {
        if (!(await exists(path.join(dir, properties.storedName)))) throw new JotError('NOT_FOUND', '回收属性缺失')
        planned.push({ from: properties.originalPath, to: sidecarPath(to), storedName: properties.storedName })
      }
    }
    try {
      for (const entry of planned) {
        await fs.promises.mkdir(path.dirname(this.abs(entry.to)), { recursive: true })
        await fs.promises.rename(path.join(dir, entry.storedName), this.abs(entry.to))
        restored.push(entry)
      }
    } catch (error) {
      for (const entry of restored.reverse()) await fs.promises.rename(this.abs(entry.to), path.join(dir, entry.storedName))
      throw error
    }
    const notUpdated = await this.updateLinks(restored)
    await this.removeTrashDirectory(dir)
    this.notifyChanges(...restored.map((e) => ({ kind: 'add' as const, path: e.to })))
    return { doc: { ...await this.read({ path: restored[0]!.to }), notUpdated }, paths: restored.map(({ from, to }) => ({ from, to })) }
  }

  async restore(trashId: string): Promise<DocMeta> {
    return (await this.restoreGroup(trashId)).doc
  }

  /** 笔记和附件共享用户目录，content/ 与 inbox/ 可以互相移动。 */
  private folderArea(rel: string): void {
    this.abs(rel)
    if (!isInUserContent(rel)) throw new JotError('WRITE_DENIED', '只能在 content/、inbox/ 或 ideas/ 中管理用户目录')
  }

  private async folderMembers(rel: string): Promise<string[]> {
    const stat = await fs.promises.lstat(this.abs(rel)).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new JotError('NOT_FOUND', '文件夹不存在或不是普通目录')
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.promises.readdir(this.abs(dir), { withFileTypes: true })) {
        const child = dir + '/' + e.name
        if (e.isSymbolicLink()) throw new JotError('INVALID_INPUT', '请先移除目录中的符号链接：' + child)
        if (e.isDirectory()) await walk(child)
        else if (e.isFile()) out.push(child)
        else throw new JotError('INVALID_INPUT', '目录中含不支持的条目：' + child)
      }
    }
    await walk(rel)
    return out
  }

  private managedFolder(rel: string): string {
    this.folderArea(rel)
    if (!rel.includes('/')) throw new JotError('WRITE_DENIED', '固定顶层目录不能改名、移动或删除')
    return rel
  }

  private folderName(raw: string): string {
    const name = raw.trim()
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name) || BAD_NAME.test(name) || name.startsWith('.') || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw new JotError('INVALID_INPUT', '请使用有效的文件夹名称')
    return name
  }

  async moveFolder(fromRaw: string, toDir: string, name?: string): Promise<import('@shared/files').MoveResult> {
    this.abs(fromRaw); this.abs(toDir)
    const from = this.managedFolder(normalizeRel(fromRaw))
    const parent = normalizeRel(toDir)
    this.folderArea(parent)
    const to = path.posix.join(parent, this.folderName(name ?? path.posix.basename(from)))
    const members = await this.folderMembers(from)
    if (to.toLowerCase() === from.toLowerCase() && to !== from) throw new JotError('INVALID_INPUT', '目录暂不支持只修改大小写，请使用不同名称')
    if (to === from) return { path: to, paths: [], notUpdated: [] }
    if (parent.toLowerCase() === from.toLowerCase() || parent.toLowerCase().startsWith(from.toLowerCase() + '/')) throw new JotError('INVALID_INPUT', '不能移动到自身或子目录')
    if (await exists(this.abs(to))) throw new JotError('CONFLICT', '目标位置已有同名文件或文件夹')
    const parentStat = await fs.promises.lstat(this.abs(parent)).catch(() => null)
    if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) throw new JotError('NOT_FOUND', '目标目录不存在')
    const paths = members.map((p) => ({ from: p, to: to + p.slice(from.length) }))
    await fs.promises.rename(this.abs(from), this.abs(to))
    const notUpdated = await this.updateLinks([{ from, to }, ...paths])
    this.notifyChanges(...paths.map((p) => ({ kind: 'remove' as const, path: p.from })), ...paths.map((p) => ({ kind: 'add' as const, path: p.to })))
    if (!paths.length) this.emitter.emit('changed', [])
    return { path: to, paths: [{ from, to }, ...paths], notUpdated }
  }

  async trashFolder(raw: string, summaries: string[] = []): Promise<{ trashId: string }> {
    this.abs(raw)
    const rel = this.managedFolder(normalizeRel(raw))
    const members = await this.folderMembers(rel)
    const external = [...new Set(summaries)].filter((p) => !p.startsWith(rel + '/'))
    const entries = [{ originalPath: rel, storedName: 'content' }, ...external.map((p, i) => ({ originalPath: p, storedName: i + '-' + path.posix.basename(p) }))]
    for (const e of entries.slice(1)) {
      if (!isSidecar(e.originalPath)) this.assertWritable(e.originalPath, 'user', 'file')
      if (!(await fs.promises.lstat(this.abs(e.originalPath))).isFile()) throw new JotError('NOT_FOUND', '关联文件不存在：' + e.originalPath)
    }
    const { trashId, dir, deletedAt } = await this.newTrashDirectory()
    const moved: typeof entries = []
    try {
      for (const e of entries) { await fs.promises.rename(this.abs(e.originalPath), path.join(dir, e.storedName)); moved.push(e) }
      await writeJson(path.join(dir, 'meta.json'), { kind: 'directory', originalPath: rel, members, entries, deletedAt })
    } catch (e) {
      for (const entry of moved.reverse()) await fs.promises.rename(path.join(dir, entry.storedName), this.abs(entry.originalPath))
      await this.removeTrashDirectory(dir)
      throw e
    }
    this.notifyChanges(...[...members, ...external].map((p) => ({ kind: 'remove' as const, path: p })))
    if (!members.length && !external.length) this.emitter.emit('changed', [])
    return { trashId }
  }

  async restoreFolder(trashId: string): Promise<import('@shared/files').MoveResult> {
    const dir = await this.trashDirectory(trashId)
    const meta = await this.trashMeta(dir)
    if (meta.kind !== 'directory') throw new JotError('INVALID_INPUT', '这一项不是目录')
    this.managedFolder(meta.originalPath)
    let root = meta.originalPath
    let n = 1
    while (await exists(this.abs(root))) root = meta.originalPath + ' ' + ++n
    const planned = [{ from: meta.originalPath, to: root, storedName: meta.entries[0]!.storedName }]
    for (const e of meta.entries.slice(1)) {
      const ext = path.posix.extname(e.originalPath)
      const base = e.originalPath.slice(0, e.originalPath.length - ext.length)
      let to = e.originalPath
      let count = 1
      while (await exists(this.abs(to)) || planned.some((p) => p.to.toLowerCase() === to.toLowerCase())) to = base + ' ' + ++count + ext
      planned.push({ from: e.originalPath, to, storedName: e.storedName })
    }
    for (const p of planned) if (!(await exists(path.join(dir, p.storedName)))) throw new JotError('NOT_FOUND', '回收内容缺失：' + p.from)
    const moved: typeof planned = []
    try {
      for (const entry of planned) {
        await fs.promises.mkdir(path.dirname(this.abs(entry.to)), { recursive: true })
        await fs.promises.rename(path.join(dir, entry.storedName), this.abs(entry.to))
        moved.push(entry)
      }
    } catch (error) {
      for (const entry of moved.reverse()) await fs.promises.rename(this.abs(entry.to), path.join(dir, entry.storedName))
      throw error
    }
    const notUpdated = await this.updateLinks(planned)
    await this.removeTrashDirectory(dir)
    const paths = [...(meta.members ?? []).map((p) => ({ from: p, to: root + p.slice(meta.originalPath.length) })), ...planned.slice(1).map(({ from, to }) => ({ from, to }))]
    this.notifyChanges(...paths.map((p) => ({ kind: 'add' as const, path: p.to })))
    if (!paths.length) this.emitter.emit('changed', [])
    return { path: root, paths: [{ from: meta.originalPath, to: root }, ...paths], notUpdated }
  }

  private async removeTrashDirectory(dir: string): Promise<void> {
    const relative = toRel(this.path, dir)
    if (!/^\.jot\/trash\/\d{4}\/(0[1-9]|1[0-2])\/[0-9A-Z]{26}$/.test(relative)) throw new JotError('INVALID_INPUT', '回收路径无效')
    await fs.promises.rm(this.abs(relative), { recursive: true })
    for (const parent of [path.dirname(dir), path.dirname(path.dirname(dir))]) {
      try { await fs.promises.rmdir(this.abs(toRel(this.path, parent))) }
      catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) console.warn('[vault] 空回收目录暂未清理：', toRel(this.path, parent))
      }
    }
  }

  async purgeTrash(trashIds: string[], canDelete?: (deletedAt: string) => boolean): Promise<void> {
    // 先校验本次确认的全部编号；后来新增的回收项不在删除范围内。
    const available = await this.trashDirectories()
    const directories = []
    for (const id of [...new Set(trashIds)]) {
      const dir = await this.trashDirectory(id, available)
      await this.trashMeta(dir)
      directories.push(dir)
    }
    let purged = false
    for (const dir of directories) {
      // 自动策略在真正删除前回读；策略关闭或时间变化后保留该项。
      if (canDelete && !canDelete((await this.trashMeta(dir)).deletedAt)) continue
      await this.removeTrashDirectory(dir)
      purged = true
    }
    if (purged) this.emitter.emit('changed', [])
  }
  async setLogTime(ref: Ref, startRaw: string, endRaw: string): Promise<DocMeta> {
    const doc = await this.read(ref)
    if (doc.type !== 'log') throw new JotError('INVALID_INPUT', '只有补记支持修改发生时间')
    const { start, end } = activityRange(startRaw, endRaw)
    return this.patchFrontmatter(ref, { start, end }, 'user')
  }
}

export { normalizeRel }
