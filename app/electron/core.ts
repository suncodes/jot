import { WorkReportService } from './operations/work-reports'
import { AiExecutor } from './agent/executor'
import { ContentService } from './content/scope'
import { LibraryPins } from './content/pins'
import type { StorageChange } from '@shared/storage'
import path from 'node:path'
import { MaintenanceService } from './maintenance/maintenance'
import { CapabilityManager } from './operations/capabilities'
import { AppOperations } from './operations/service'
import { CommandService } from './commands/service'
import { AppExtensionState } from './extensions/state'
import { AppExtensionManager } from './extensions/manager'
import { NoteTemplateService } from './extensions/templates'
import { DateNoteService } from './commands/date-note'
import { WorkDiaryService } from './commands/work-diary'
import type { EventContract, EventName } from '@shared/ipc'
import fs from 'node:fs'
import { JotError } from '@shared/result'
import type { DocMeta, VaultChange } from '@shared/types'
import { PiHost } from './agent/pi'
import { AgentService } from './agent/service'
import type { ModelConfig } from './env'
import { IndexService } from './index/index'
import { LinkService } from './index/links'
import { JobQueue } from './jobs/queue'
import { ClassifyPipeline } from './pipelines/classify'
import { DailyPipeline } from './pipelines/daily'
import { FileArchive } from './pipelines/files'
import { TaxonomyService } from './pipelines/taxonomy'
import { StateStore } from './state/state'
import { ModelDiagnostics } from './llm/diagnostics'
import { SettingsService, type SecretStore } from './settings/settings'
import { isTextFile } from './vault/vault'
import { isSidecar, ownerPath, sidecarPath } from './vault/metadata'
import { DIRS, isInMeta, isInTemplates } from './vault/paths'
import { VaultService } from './vault/vault'

export interface CoreOptions {
  /** 应用数据目录：放设置和 Pi 的配置，不在库里 */
  userDataDir: string
  bundledPluginRoot?: string
  bundledAppExtensionRoot?: string
  secrets: SecretStore
  devModel: ModelConfig | null
  /** 推送事件给界面 */
  emit: <E extends EventName>(event: E, data: EventContract[E]) => void
  /** 当前时间，测试里可以替换 */
  now?: () => Date
  systemDarkMode?: () => boolean
}

/**
 * 把各个服务组装起来，并负责它们之间的联动（文件变化 → 更新索引 → 通知界面）。
 * 不依赖 Electron，可以在测试里直接创建。
 */
export class Core {
  readonly vault = new VaultService()
  readonly index = new IndexService()
  readonly state = new StateStore()
  readonly links = new LinkService(this.index, this.vault)
  readonly jobs = new JobQueue(this.state)
  readonly content: ContentService
  readonly pins = new LibraryPins(this.vault, () => this.opts.emit('library:pinsChanged', null))
  readonly settings: SettingsService
  readonly model: ModelDiagnostics
  readonly classify: ClassifyPipeline
  readonly files: FileArchive
  readonly agent: AgentService
  readonly pi: PiHost
  readonly executor: AiExecutor
  readonly daily: DailyPipeline
  readonly taxonomy: TaxonomyService
  readonly maintenance: MaintenanceService
  readonly capabilities: CapabilityManager
  readonly operations: AppOperations
  readonly extensionState = new AppExtensionState(this.vault)
  readonly commands: CommandService
  readonly extensions: AppExtensionManager
  readonly templates = new NoteTemplateService(this.vault)
  readonly dateNotes: DateNoteService
  readonly workDiary: WorkDiaryService
  readonly workReports: WorkReportService
  private scheduleTimer: NodeJS.Timeout | null = null
  /** 正在进行的定时检查，关闭前要等它结束 */
  private ticking: Promise<unknown> = Promise.resolve()
  /** 文件变化按顺序处理，这是处理队列的末尾 */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: CoreOptions) {
    this.vault.bundledPluginRoot = opts.bundledPluginRoot ?? this.vault.bundledPluginRoot
    if (opts.now) this.vault.setClock(opts.now)
    this.settings = new SettingsService(opts.userDataDir, opts.secrets, opts.devModel)
    this.model = new ModelDiagnostics(() => this.settings.getModelConfig())
    this.content = new ContentService(this.vault, this.index, () => this.files.catalog(), () => this.state.isOpen ? this.classify.pendingPaths() : [])
    this.index.setContentQueries(this.content)
    this.pi = new PiHost(path.join(opts.userDataDir, 'pi'), modelId => this.settings.getModelConfig(modelId), (config, state, message) => this.model.report(config, state, message))
    this.executor = new AiExecutor(this.pi, this.vault, this.index, operation => this.mutate(operation))
    this.classify = new ClassifyPipeline({
      vault: this.vault, index: this.index, state: this.state, executor: this.executor,
      content: this.content, jobs: this.jobs, mutate: operation => this.mutate(operation),
      moved: changes => this.moved(changes),
    })
    this.files = new FileArchive({
      vault: this.vault, index: this.index, state: this.state, jobs: this.jobs, executor: this.executor,
      mutate: operation => this.mutate(operation),
      indexFile: (rel) => this.indexFile(rel),
      now: opts.now ?? (() => new Date()),
      changed: () => opts.emit('files:changed', null),
    })
    this.agent = new AgentService({
      vault: this.vault, index: this.index, state: this.state,
      pi: this.pi, executor: this.executor,
      now: opts.now,
      operations: () => this.operations,
      fileOps: {
        mutate: operation => this.mutate(operation), changed: () => this.idle(),
        moved: async paths => {
          await this.movePins(paths)
          this.agent.moveReferences(paths)
          this.notifyStorage({ paths: paths.map(p => p.to), moves: paths, kind: 'path' })
        },
        trashed: paths => { this.jobs.cancelTargets(paths); for (const path of paths) this.state.removeSuggestion(path) },
      },
      emit: (event) => opts.emit('agent:event', event),
      changed: (conversationId, deleted) => opts.emit('agent:changed', { conversationId, deleted }),
    })
    this.daily = new DailyPipeline({
      vault: this.vault, index: this.index, state: this.state, jobs: this.jobs, executor: this.executor,
      now: opts.now ?? (() => new Date()),
      settings: () => this.settings.get().daily,
      idle: () => this.idle(),
      mutate: operation => this.mutate(operation),
    })
    this.taxonomy = new TaxonomyService({
      vault: this.vault, index: this.index, state: this.state, jobs: this.jobs, executor: this.executor,
      terms: (kind) => this.classify.terms(kind),
      mutate: operation => this.mutate(operation),
      idle: () => this.idle(),
      changed: () => opts.emit('taxonomy:changed', null),
    })
    this.jobs.register('find-synonyms', async (payload, ctx) => {
      return (await this.taxonomy.findSynonyms(payload.kind as 'tag' | 'place' | 'person', { signal: ctx.signal, onExecution: ctx.recordExecution })).note
    })
    this.jobs.register('daily', async (payload, ctx) => {
      const result = await this.daily.run(String(payload.date), { force: payload.force === true, signal: ctx.signal, onExecution: ctx.recordExecution })
      await this.idle()
      return result === 'written' ? '日总结已保存' : result === 'kept' ? '已保留现有日总结' : '当天没有可用记录'
    })
    this.jobs.register('summarize-file', async (payload, ctx) => {
      await this.idle()
      const note = await this.files.summarize(String(payload.path), { force: payload.force === true, signal: ctx.signal, onExecution: ctx.recordExecution, summaryPath: typeof payload.summaryPath === 'string' ? payload.summaryPath : undefined })
      await this.idle()
      const summary = this.files.summaries(String(payload.path))[0]
      if (summary) this.enqueueClassify(summary)
      return note
    })
    this.jobs.register('classify', async (payload, ctx) => {
      await this.idle()
      const result = await this.classify.run(String(payload.path), { force: payload.force === true, signal: ctx.signal, onExecution: ctx.recordExecution })
      // 分析产生了独立建议，索引同步后通知待处理计数
      await this.idle()
      this.emitInboxCount()
      return result.note
    })
    this.maintenance = new MaintenanceService({
      vault: this.vault, index: this.index, state: this.state, settings: this.settings,
      userDataDir: opts.userDataDir, now: opts.now ?? (() => new Date()),
      busy: exceptConversationId => this.jobs.isRunning || this.agent.isBusy(exceptConversationId),
      idle: () => this.idle(), mutate: operation => this.mutate(operation),
    })
    this.capabilities = new CapabilityManager(this, () => opts.emit('capabilities:changed', null))
    this.operations = new AppOperations(this)
    this.commands = new CommandService(this, () => opts.emit('commands:changed', null), opts.systemDarkMode)
    this.dateNotes = new DateNoteService(this)
    this.workDiary = new WorkDiaryService(this)
    this.workReports = new WorkReportService(this)
    this.extensions = new AppExtensionManager(this, opts.bundledAppExtensionRoot ?? path.resolve(import.meta.dirname, '../../resources/app-extensions'),
      () => opts.emit('extensions:changed', null), () => opts.emit('capabilities:changed', null))

    this.jobs.onUpdate((summary, job) => {
      opts.emit('jobs:updated', { ...summary, job })
      if (job?.type === 'classify') this.emitInboxCount()
    })
    this.model.onStatus((state, message) => {
      opts.emit('model:status', { state, message })
      if (state === 'ok') this.jobs.kick()
    })
    this.settings.onChange((settings, modelChanged) => {
      opts.emit('settings:changed', settings)
      this.model.refresh()
      if (modelChanged) this.agent.refreshReasoningSelections()
      opts.emit('model:status', { state: this.model.status() })
      this.jobs.kick()
    })
    this.vault.setLinkMaintainer(changes => this.links.maintain(changes))
    this.vault.on('changed', (changes) => {
      this.queue = this.queue.then(() => this.applyChanges(changes)).then(() => {}).catch((e) => console.error('[core] 处理文件变化出错：', e))
    })
  }

  /** 启动：读设置，上次的库还在就打开。打不开不算错误，界面会回到首次启动的引导。 */
  async init(): Promise<void> {
    await this.settings.load()
    const last = this.settings.vaultPath
    if (!last) return
    try {
      await this.openVault(last, false)
    } catch (e) {
      console.warn('[core] 打不开上次的库：', e instanceof Error ? e.message : e)
    }
  }

  now(): Date { return this.opts.now?.() ?? new Date() }

  openVault(dir: string, create: boolean): Promise<{ path: string }> {
    return this.commands.changeVault(async () => {
      try { return await this.openCurrentVault(dir, create) }
      catch (error) {
        if (this.vault.isOpen && this.index.isOpen) await this.extensions.reload()
        throw error
      }
    }).finally(() => this.opts.emit('extensions:changed', null))
  }

  private async openCurrentVault(dir: string, create: boolean): Promise<{ path: string }> {
    await this.idle()
    this.extensions.clear()
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    await this.ticking
    await this.jobs.stop()
    await this.agent.reset()
    this.capabilities.clear()
    this.scheduleTimer = null
    const opened = await this.vault.open(dir, create)
    try {
      // 应用状态不可重建，先校验其格式，再打开可重建索引。
      this.state.open(path.join(opened.path, DIRS.meta, 'state.db'))
      this.index.open(path.join(opened.path, DIRS.meta, 'index.db'))
      this.agent.recoverInterrupted()
      await this.syncIndex()
      await this.extensions.reload()
      this.vault.startWatching()
      await this.settings.setVaultPath(opened.path)
      this.jobs.start()
      this.maintenance.reset()
    } catch (error) {
      this.state.close(); this.index.close(); await this.vault.close()
      throw error
    }
    // 定时工作共用一个入口；尚未结束的检查不会重复排入队列。
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    let checking = false
    const tick = () => {
      if (checking) return
      checking = true
      this.ticking = (async () => {
        await this.daily.tick().catch((e) => console.warn('[core] 日总结定时检查出错：', e instanceof Error ? e.message : e))
        await this.maintenance.tick().catch((e) => console.warn('[core] 系统维护出错：', e instanceof Error ? e.message : e))
      })().finally(() => { checking = false })
    }
    this.scheduleTimer = setInterval(tick, 60_000)
    this.scheduleTimer.unref()
    tick()
    return opened
  }

  private emitInboxCount(): void {
    if (this.index.isOpen) this.opts.emit('inbox:count', { count: this.classify.inbox({ limit: 1 }).total })
  }

  /** 为明确捕获／导入排分析任务。已经有建议的不再排，避免反复打扰。 */
  private enqueueClassify(rel: string): void {
    const target = this.index.getDoc(rel)?.sourcePath ?? rel
    if (this.files.isSource(rel) || !this.settings.get().classify.enabled || this.state.getSuggestions(target).length) return
    this.jobs.enqueuePath('classify', target)
  }

  /** 用户主动重新归类；任务读当前路径，不保存文件身份。 */
  rerunClassify(rel: string): string {
    this.vault.abs(rel)
    const id = this.jobs.enqueuePath('classify', this.index.getDoc(rel)?.sourcePath ?? rel, { force: true, explicit: true })
    return id
  }

  private async indexFile(rel: string): Promise<DocMeta | null> {
    if (isSidecar(rel) || isInTemplates(rel)) return null
    try {
      const stat = await fs.promises.stat(this.vault.abs(rel))
      if (!stat.isFile()) return null
      const raw = isTextFile(rel) && stat.size <= 10 * 1024 * 1024 ? await this.vault.readRaw(rel)
        : { text: '', mtimeMs: stat.mtimeMs, size: stat.size, birthtime: stat.birthtime, mtime: stat.mtime, properties: await this.vault.metadata.read(rel, '') }
      return this.index.upsert({ path: rel, ...raw, source: raw.properties.attachment })
    } catch (error) {
      console.warn('[core] 索引失败 ' + rel + '：', error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /**
   * 让索引和磁盘一致：补上新增和改过的，去掉已经不在的。rebuild 为 true 时先清空。
   * 和文件变化的处理排在同一个队列里，两边不会交错着改同一个文件的记录。
   */
  syncIndex(rebuild = false): Promise<{ indexed: number; removed: number }> {
    const run = this.queue.then(() => this.doSyncIndex(rebuild))
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private async doSyncIndex(rebuild: boolean): Promise<{ indexed: number; removed: number }> {
    const all = await this.vault.listFiles()
    const legacy = all.find(file => /^(notes|files|projects)\//i.test(file.path))
    if (legacy) throw new JotError('INVALID_INPUT', '请先将旧目录整理到 content/：' + legacy.path)
    if (rebuild) this.index.clear()
    const onDisk = new Set(all.map(file => file.path))
    let indexed = 0
    let removed = 0
    const changes: VaultChange[] = []
    for (const file of all) {
      const properties = await fs.promises.stat(this.vault.abs(sidecarPath(file.path))).catch(() => null)
      if (this.index.needsUpdate(file.path, file.mtimeMs, file.size, properties ? { mtimeMs: properties.mtimeMs, size: properties.size } : null)) {
        if (await this.indexFile(file.path)) { indexed++; changes.push({ path: file.path, kind: 'change' }) }
      }
    }
    for (const rel of this.index.allPaths()) if (!onDisk.has(rel)) {
      this.index.remove(rel)
      this.state.removeSuggestion(rel)
      this.jobs.cancelTargets([rel])
      removed++
      changes.push({ path: rel, kind: 'remove' })
    }
    // 清单同步也可能只发现空目录变化，内容库仍需重新投影目录。
    this.notifyIndex([...changes, { path: 'content', kind: 'change' }])
    return { indexed, removed }
  }

  private notifyIndex(changes: VaultChange[]): void {
    this.opts.emit('vault:changed', { changes })
    this.opts.emit('files:changed', null)
    this.emitInboxCount()
  }

  /** 监听只更新查询缓存，自动 AI 任务由明确的捕获／导入入口安排。 */
  private async applyChanges(changes: VaultChange[]): Promise<{ indexed: number; removed: number }> {
    if (!this.vault.isOpen || !this.index.isOpen) return { indexed: 0, removed: 0 }
    const affected = [...new Set(changes.map(change => ownerPath(change.path)))].filter(rel => !isInTemplates(rel))
    const paths = new Set<string>()
    for (const rel of affected) {
      const stat = await fs.promises.stat(this.vault.abs(rel)).catch(() => null)
      if (stat?.isFile()) paths.add(rel)
      if (stat?.isDirectory()) for (const file of await this.vault.listFiles(rel)) paths.add(file.path)
      for (const cached of this.index.allPaths()) if (cached === rel || cached.startsWith(rel + '/')) paths.add(cached)
    }
    let indexed = 0
    let removed = 0
    for (const rel of paths) {
      const stat = await fs.promises.stat(this.vault.abs(rel)).catch(() => null)
      if (!stat?.isFile()) {
        this.index.remove(rel)
        this.state.removeSuggestion(rel)
        this.jobs.cancelTargets([rel])
        removed++
        continue
      }
      const properties = await fs.promises.stat(this.vault.abs(sidecarPath(rel))).catch(() => null)
      if (!this.index.needsUpdate(rel, stat.mtimeMs, stat.size, properties ? { mtimeMs: properties.mtimeMs, size: properties.size } : null)) continue
      const meta = await this.indexFile(rel)
      if (meta) { indexed++; this.opts.emit('doc:updated', this.decorate(meta)) }
    }
    this.notifyIndex(changes)
    return { indexed, removed }
  }

  refreshIndex(paths?: string[]): Promise<{ indexed: number; removed: number }> {
    if (!paths) return this.syncIndex()
    for (const rel of paths) {
      this.vault.abs(rel)
      if (isInMeta(rel)) throw new JotError('PATH_OUTSIDE_VAULT', '不能索引软件数据目录')
      if (isInTemplates(rel)) throw new JotError('INVALID_INPUT', 'templates/ 是模板资源，不参与内容索引')
    }
    return this.mutate(() => this.applyChanges(paths.map(rel => ({ path: rel, kind: 'change' as const }))))
  }

  captured(rel: string): void { this.enqueueClassify(rel) }

  private async movePins(paths: import('@shared/files').PathChange[]): Promise<void> {
    // 文件已经移动，固定配置失败不能把成功的文件操作报告为失败。
    try { await this.pins.move(paths) }
    catch (error) { console.warn('[core] 文件已移动，固定入口未更新：', error instanceof Error ? error.message : error) }
  }

  async moved(paths: import('@shared/files').PathChange[]): Promise<void> {
    await this.movePins(paths)
    this.state.moveSuggestions(paths)
    this.jobs.moveTargets(paths)
    this.agent.moveReferences(paths)
    this.notifyStorage({ paths: paths.map(p => p.to), moves: paths, kind: 'path' })
  }

  notifyStorage(change: StorageChange): void { this.opts.emit('storage:changed', change) }

  notifyMetadata(meta: DocMeta): void {
    this.opts.emit('doc:updated', meta)
    this.opts.emit('files:changed', null)
    this.opts.emit('taxonomy:changed', null)
    this.emitInboxCount()
  }
  /** 摘要页来源可用性按当前磁盘路径检查 */
  decorate<T extends DocMeta>(meta: T): T {
    const out = { ...meta }
    if (out.sourcePath) {
      let missing = true
      try {
        missing = !fs.existsSync(this.vault.abs(out.sourcePath))
      } catch {
        missing = true
      }
      out.sourceMissing = out.sourceMissing ?? missing
    }
    return out
  }

  /**
   * 等后台的事情都做完：启动时的定时检查、已经发生的文件变化、已经到期的任务。
   * 测试和造示例数据时用，免得靠“等一小会儿”来碰运气。
   */
  async quiesce(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await this.ticking
      await this.idle()
      await this.jobs.settle()
    }
  }

  /** 文件操作及其状态迁移完成后，才让监听事件更新索引。 */
  mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation)
    this.queue = run.then(() => {}, () => {})
    return run
  }

  /** 等待已经发生的文件变化都处理完 */
  async idle(): Promise<void> {
    this.vault.flush()
    await this.queue
  }

  dispose(): Promise<void> {
    return this.commands.changeVault(() => this.disposeCurrentVault())
  }

  private async disposeCurrentVault(): Promise<void> {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.scheduleTimer = null
    await this.ticking
    await this.jobs.stop()
    await this.agent.reset()
    await this.idle().catch(() => {})
    this.extensions.clear()
    await this.vault.close()
    this.index.close()
    this.state.close()
  }
}
