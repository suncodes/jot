import { captureShortcut } from '@shared/shortcut-keys'
import type { Args, Ret } from '@shared/ipc'
import type { ConversationExportFormat } from '@shared/conversation-export'
import { conversationExportName, saveConversationExport } from '../agent/export'
import type { DocMeta, FolderChange } from '@shared/types'
import { JotError } from '@shared/result'
import type { Core } from '../core'
import { argSchemas } from '../ipc/schemas'
import { extractHashtags } from '../pipelines/classify'
import type { Handlers } from '../ipc/register'

/** 固定业务入口供界面和助手共用；不允许任意 IPC 分发。 */
export const OPERATION_CHANNELS = [
  'maintenance:usage',
  'maintenance:clearTemporary',
  'maintenance:optimizeDatabases',
  'vault:refreshIndex',
  'vault:rebuildIndex',
  'vault:createFolder',
  'content:move',
  'doc:patchProperties',
  'doc:editText',
  'capture:save',
  'capture:saveLog',
  'doc:create',
  'doc:setClassification',
  'doc:setOccurredAt',
  'doc:setLogTime',
  'folder:restore',
  'doc:restore',
  'trash:list',
  'trash:purge',
  'classify:inbox',
  'classify:accept',
  'classify:skip',
  'classify:rerun',
  'taxonomy:create',
  'taxonomy:remove',
  'taxonomy:terms',
  'taxonomy:rename',
  'taxonomy:merge',
  'taxonomy:findSynonyms',
  'taxonomy:synonyms',
  'taxonomy:dismissSynonym',
  'files:import',
  'files:list',
  'files:reprocess',
  'timeline:day',
  'timeline:daysWithRecords',
  'timeline:generateDaily',
  'agent:conversations',
  'agent:get',
  'agent:rename',
  'agent:delete',
  'agent:export',
  'jobs:list',
  'jobs:retry',
  'jobs:cancel',
  'settings:get',
  'settings:set',
] as const
export type OperationChannel = typeof OPERATION_CHANNELS[number]
export type OperationHandlers = Pick<Handlers, OperationChannel>

export interface OperationPlatform {
  trashItem(absolute: string): Promise<void>
  pickFiles(): Promise<string[] | null>
  saveFile(options: { defaultPath: string; format: ConversationExportFormat }): Promise<string | null>
}

export class AppOperations {
  get capabilities() { return this.core.capabilities }
  get workReports() { return this.core.workReports }
  private platform?: OperationPlatform
  private exporting = false
  setPlatform(platform: OperationPlatform): void { this.platform = platform }
  async trashExternal(absolute: string): Promise<void> {
    if (!this.platform) throw new JotError('IO_ERROR', '系统回收站服务未连接')
    await this.platform.trashItem(absolute)
  }
  readonly handlers: OperationHandlers
  constructor(private readonly core: Core) {
    const { vault, settings, classify, jobs, state, files } = core
    const directoryPath = (dir?: string): string => dir ?? 'content'
    const updateMetadata = async (operation: () => Promise<DocMeta>): Promise<DocMeta> => {
      await core.idle()
      const meta = core.decorate(await core.mutate(operation))
      await core.idle()
      core.notifyMetadata(meta)
      return meta
    }
    const moveRecords = (paths: FolderChange['paths']): Promise<void> => core.moved(paths)
    const restoreFiles = async <T extends { paths: FolderChange['paths'] }>(operation: () => Promise<T>): Promise<T> => {
      await core.idle()
      const result = await core.mutate(operation)
      await core.idle()
      return result
    }
    this.handlers = {
      'maintenance:usage': async () => { await core.idle(); return core.maintenance.usage() },
      'maintenance:clearTemporary': ({ vaultPath }) => core.maintenance.clearTemporary(vaultPath),
      'maintenance:optimizeDatabases': ({ vaultPath }) => core.maintenance.optimizeDatabases(vaultPath),
      'vault:refreshIndex': ({ paths }) => core.refreshIndex(paths),
      'vault:rebuildIndex': () => core.syncIndex(true),
      'vault:createFolder': ({ parent, name }) => core.mutate(() => vault.createFolder(directoryPath(parent), name)),

      'content:move': async ({ path, targetPath }) => {
        await core.idle()
        const result = await core.mutate(async () => {
          const changed = await vault.movePath(path, targetPath)
          await moveRecords(changed.paths)
          return changed
        })
        await core.idle()
        return result
      },
      'doc:patchProperties': async ({ path, patch }) => {
        const doc = await core.mutate(async () => {
          const result = await vault.patchFrontmatter({ path }, patch, 'user')
          state.discardPropertySuggestions(path, Object.keys(patch))
          return result
        })
        await core.idle()
        return doc
      },
      'doc:editText': ({ path, before, after }) => core.mutate(() => vault.editText(path, before, after)),
      'capture:save': async ({ text, source }) => {
        // 正文里的 #标签 直接作为标签，算你确认过的
        const tags = extractHashtags(text)
        const meta = await core.mutate(() => vault.createIdea({ text, source, tags }))
        state.confirmTerms('tag', tags)
        await core.idle()
        core.captured(meta.path)
        return meta
      },
      'capture:saveLog': async (input) => {
        const meta = await core.mutate(() => vault.createLog(input))
        await core.idle()
        core.captured(meta.path)
        return meta
      },
      'doc:create': async ({ classification, ...input }) => {
        const result = await core.mutate(async () => {
          const meta = await vault.createNote(input)
          return classification ? classify.setByUser({ path: meta.path }, classification) : meta
        })
        await core.idle()
        return result
      },
      'doc:setClassification': ({ ref, patch }) => updateMetadata(() => classify.setByUser(ref, patch)),
      'doc:setOccurredAt': ({ ref, occurredAt }) => updateMetadata(async () => {
        const doc = await vault.read(ref)
        if (doc.type === 'log') throw new JotError('WRITE_DENIED', '补记请使用区间时间入口')
        return vault.patchFrontmatter({ path: doc.type === 'source-summary' && doc.sourcePath ? doc.sourcePath : doc.path }, { occurred_at: occurredAt }, 'user')
      }),
      'doc:setLogTime': ({ ref, start, end }) => core.mutate(() => vault.setLogTime(ref, start, end)),
      'folder:restore': ({ trashId }) => restoreFiles(() => vault.restoreFolder(trashId)),
      'doc:restore': async ({ trashId }) => (await restoreFiles(() => vault.restoreGroup(trashId))).doc,
      'trash:list': (page) => vault.trashList(page),
      'trash:purge': ({ trashIds }) => core.mutate(() => vault.purgeTrash(trashIds)),
      'classify:inbox': async (page) => {
        await core.idle()
        return classify.inbox(page)
      },
      'classify:accept': ({ ref, kind, toDir }) => updateMetadata(() => classify.accept(ref, kind, toDir)),
      'classify:skip': ({ ref, kind }) => updateMetadata(() => classify.skip(ref, kind)),
      'classify:rerun': async ({ ref }) => {
        const doc = await vault.read(ref)
        return { jobId: core.rerunClassify(doc.sourcePath ?? doc.path) }
      },

      'taxonomy:create': async ({ kind, name }) => {
        await core.idle()
        return core.mutate(async () => core.taxonomy.create(kind, name))
      },
      'taxonomy:remove': ({ kind, name, into }) => core.taxonomy.remove(kind, name, into),
      'taxonomy:terms': async ({ kind }) => {
        await core.idle()
        return classify.terms(kind)
      },

      'taxonomy:rename': ({ kind, from, to }) => core.taxonomy.rename(kind, from, to),
      'taxonomy:merge': async ({ kind, from, into }) => {
        const r = await core.taxonomy.merge(kind, from, into)
        core.taxonomy.dropSuggestionsFor(kind, [...from, into])
        return r
      },
      'taxonomy:findSynonyms': ({ kind }) => core.taxonomy.requestSynonyms(kind),
      'taxonomy:synonyms': () => core.taxonomy.synonyms(),
      'taxonomy:dismissSynonym': ({ id }) => core.taxonomy.dismiss(id),

      'files:import': ({ paths, toDir }) => core.mutate(() => files.import(paths, toDir)),
      'files:list': async (page) => {
        await core.idle()
        return files.list(page)
      },
      'files:reprocess': async ({ path, force, summaryPath }) => { await core.idle(); return core.mutate(() => files.reprocess(path, force, summaryPath)) },

      'timeline:day': async ({ date }) => {
        await core.idle()
        return core.daily.view(date)
      },
      'timeline:daysWithRecords': async ({ month }) => {
        await core.idle()
        return core.daily.daysWithRecords(month)
      },
      'timeline:generateDaily': async ({ date, force }) => {
        await core.idle()
        return core.daily.request(date, force)
      },

      'agent:conversations': (page) => core.agent.conversations(page),
      'agent:get': ({ conversationId }) => core.agent.get(conversationId),
      'agent:rename': ({ conversationId, title }) => core.agent.rename(conversationId, title),
      'agent:delete': ({ conversationId }) => core.agent.delete(conversationId),
      'agent:export': ({ conversationId, format }) => this.exportConversation(conversationId, format),
      'jobs:list': ({ state: jobState, states, limit, offset }) => jobs.list({ state: jobState, states }, { limit, offset }),
      'jobs:retry': ({ jobId }) => jobs.retry(jobId),
      'jobs:cancel': ({ jobId }) => jobs.cancel(jobId),

      'settings:get': () => settings.get(),
      'settings:set': input => {
        if (!input.capture?.hotkey || !core.vault.isOpen) return settings.set(input)
        return core.mutate(async () => {
          const hotkey = captureShortcut(input.capture!.hotkey!)
          const shortcuts = await core.extensionState.getShortcuts()
          if (hotkey && shortcuts.bindings.some(binding => binding.hotkey.replace('Meta+', 'Ctrl+') === hotkey.replace('Meta+', 'Ctrl+'))) {
            throw new JotError('CONFLICT', '快速记录快捷键与已有应用快捷键冲突')
          }
          return settings.set(input)
        })
      },
    }
  }

  /** 导入来源由系统窗口选择，助手不遍历库外文件。 */
  async importSelected(toDir?: string, signal?: AbortSignal) {
    if (!this.platform) throw new JotError('CONFLICT', '系统文件窗口未连接')
    const database = this.core.state.raw
    const paths = await this.platform.pickFiles()
    if (!paths?.length) return { cancelled: true, imported: [], skipped: [] }
    if (signal?.aborted) throw new JotError('CANCELLED', '操作已停止')
    if (!this.core.state.isOpen || this.core.state.raw !== database) throw new JotError('CONFLICT', '库已切换，请重新选择文件')
    return this.execute('files:import', { paths, toDir })
  }

  async exportConversation(conversationId: string, format: ConversationExportFormat, signal?: AbortSignal) {
    if (!this.platform) throw new JotError('CONFLICT', '系统保存窗口未连接')
    if (this.exporting) throw new JotError('CONFLICT', '请等待当前导出完成')
    const { agent, state, vault } = this.core
    const snapshot = agent.exportSnapshot(conversationId), database = state.raw
    this.exporting = true
    try {
      const target = await this.platform.saveFile({ defaultPath: conversationExportName(snapshot.info.title, format), format })
      if (!target) return null
      if (signal?.aborted) throw new JotError('CANCELLED', '操作已停止')
      return await this.core.mutate(async () => {
        if (signal?.aborted) throw new JotError('CANCELLED', '操作已停止')
        if (!state.isOpen || state.raw !== database) throw new JotError('CONFLICT', '库已切换，请在当前库重试')
        agent.exportSnapshot(conversationId)
        await saveConversationExport(vault, snapshot, format, target)
        return { path: target }
      })
    } finally { this.exporting = false }
  }

  async termTargets(kind: import('@shared/types').TermKind, names: string[]): Promise<string[]> {
    await this.core.idle()
    return [...new Set(names.flatMap(name => this.core.index.pathsUsing(kind, name, kind === 'tag')))]
      .filter(path => {
        const doc = this.core.index.getDoc(path)
        return !(doc?.type === 'source-summary' && doc.sourcePath && this.core.index.getDoc(doc.sourcePath))
      }).sort()
  }

  async trashItems(ids: string[]) {
    const all = await this.core.vault.trashList({ limit: Number.MAX_SAFE_INTEGER })
    return ids.map(id => {
      const item = all.items.find(item => item.trashId === id)
      if (!item) throw new JotError('NOT_FOUND', '没有这个回收项：' + id)
      return item
    })
  }

  optimizeForAssistant(conversationId: string) {
    return this.core.maintenance.optimizeDatabases(this.core.vault.path, conversationId)
  }

  summaries(path: string): string[] { return this.core.files.summaries(path) }
  scopedTerms(kind: import('@shared/types').TermKind, scope: import('@shared/types').SearchFilter) {
    return this.core.index.filterTerms(kind, scope)
  }
  job(id: string) { return this.core.jobs.info(id) }
  async execute<K extends OperationChannel>(channel: K, input: Args<K>): Promise<Ret<K>> {
    const checked = argSchemas[channel].safeParse(input)
    if (!checked.success) throw new JotError('INVALID_INPUT', checked.error.issues.map(issue => issue.path.join('.') + ': ' + issue.message).join('; '))
    return await this.handlers[channel](checked.data as Args<K>)
  }
}
