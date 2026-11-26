import type { ReasoningEffort, ResolvedReasoning } from './reasoning'
import type { AppExtensionCatalog, AppExtensionConfiguration, AppExtensionImportPreview, AppExtensionImportRequest, AppExtensionProfile, AppExtensionProfileInput, ProfileShortcutInput, NoteTemplate, ShortcutConfiguration } from './app-extensions'
import type { AppCommand, CommandResult } from './commands'
import type { DateNotePath, DateNotePreview } from './date-paths'
import type { WorkReportMonthPreview, WorkReportOptions } from './work-reports'
import type { ContentScope, StorageChange } from './storage'
import type { DatabaseMaintenance, StorageUsage, TemporaryCleanup } from './maintenance'
import type { AssistantContext, RunRecord } from './assistant'
import type { ConversationExportFormat } from './conversation-export'
import type { CompactionThreshold, ResolvedModelBudget } from './model-budget'
// IPC 契约：通道名、参数类型、返回类型。见 docs/architecture.md。
// 新增通道时：在这里加类型，在 electron/ipc/schemas.ts 加参数校验，在 electron/ipc/handlers.ts 里实现。

import type { Result } from './result'
import type { CapabilityFileInput, CapabilityOwner, CapabilityResource, PluginChange, AgentChange, CapabilityCatalog, PluginImportPreview, SkillChange, SkillImportPreview } from './capabilities'
import type {
  AgentEvent, AppInfo, ChatMessage, ClassificationPatch, ConversationInfo, FolderChange, DayView, Doc, DocMeta, FileItem, InboxItem, JobInfo, JobsSummary, JobState, LibraryFacets, LibraryItem, LibraryQuery, ModelState, ModelTestResult, Paged,
  Ref, SearchFilter, SearchHit, Settings, SettingsInput, SynonymGroup, TermInfo, TermKind, TrashItem, TreeNode, VaultChange, VaultStatus,
} from './types'

export interface IpcContract {
  'library:pins': { args: void; result: import('./files').LibraryPin[] }
  'library:setPinned': { args: { path: string; kind: 'file' | 'folder'; pinned: boolean }; result: import('./files').LibraryPin[] }
  'library:reorderPin': { args: { path: string; direction: 'up' | 'down' }; result: import('./files').LibraryPin[] }
  'commands:list': { args: { query?: string; availableOnly?: boolean }; result: AppCommand[] }
  'commands:execute': { args: { id: string }; result: CommandResult }
  'extensions:configuration': { args: void; result: AppExtensionConfiguration }
  'extensions:catalog': { args: void; result: AppExtensionCatalog }
  'extensions:previewImport': { args: AppExtensionImportRequest; result: AppExtensionImportPreview | null }
  'extensions:confirmImport': { args: { token: string; installAiPlugin?: boolean }; result: AppExtensionCatalog }
  'extensions:cancelImport': { args: { token: string }; result: void }
  'extensions:previewAiPlugin': { args: { id: string }; result: PluginImportPreview }
  'extensions:confirmAiPlugin': { args: { token: string }; result: AppExtensionCatalog }
  'extensions:cancelAiPlugin': { args: { token: string }; result: void }
  'extensions:setEnabled': { args: { id: string; enabled: boolean }; result: AppExtensionCatalog }
  'extensions:saveProfile': { args: { id: string; profile: AppExtensionProfileInput; shortcut?: ProfileShortcutInput }; result: AppExtensionProfile }
  'extensions:removeProfile': { args: { id: string; profileId: string }; result: AppExtensionCatalog }
  'extensions:uninstall': { args: { id: string; confirmed: true }; result: AppExtensionCatalog }
  'extensions:readTemplate': { args: { id: string; template: NoteTemplate }; result: string }
  'extensions:copyTemplate': { args: { id: string; path: string; targetPath: string }; result: { path: string } }
  'extensions:previewDateNote': { args: DateNotePath; result: DateNotePreview }
  'extensions:previewWorkReport': { args: WorkReportOptions; result: WorkReportMonthPreview }
  'shortcuts:get': { args: void; result: ShortcutConfiguration }
  'shortcuts:set': { args: ShortcutConfiguration; result: ShortcutConfiguration }
  'maintenance:usage': { args: void; result: StorageUsage }
  'maintenance:clearTemporary': { args: { vaultPath: string; confirmed: true }; result: TemporaryCleanup }
  'maintenance:optimizeDatabases': { args: { vaultPath: string }; result: DatabaseMaintenance }
  'vault:refreshIndex': { args: { paths?: string[] }; result: { indexed: number; removed: number } }
  'doc:properties': { args: { path: string }; result: import('./files').PropertyDocument }
  'doc:patchProperties': { args: { path: string; patch: Record<string, unknown> }; result: DocMeta }
  'doc:editText': { args: { path: string; before: string; after: string }; result: void }
  'content:move': { args: { path: string; targetPath: string }; result: import('./files').MoveResult }
  'links:list': { args: { path: string; direction?: 'incoming' | 'outgoing' }; result: import('./files').FileLink[] }

  'app:info': { args: void; result: AppInfo }
  /** 界面启动时取一次当前状态，之后靠事件更新 */
  'app:status': { args: void; result: { inboxCount: number; jobs: JobsSummary; modelState: ModelState } }

  'vault:status': { args: void; result: VaultStatus }
  'vault:pick': { args: void; result: { path: string } | null }
  'vault:open': { args: { path: string; create: boolean }; result: { path: string } }
  'vault:tree': { args: { dir?: string }; result: TreeNode[] }
  'vault:rebuildIndex': { args: void; result: { indexed: number; removed: number } }
  'folder:move': { args: { path: string; toDir: string; name?: string }; result: FolderChange }
  'folder:delete': { args: { path: string }; result: { trashId: string } }
  'folder:restore': { args: { trashId: string }; result: FolderChange }
  'trash:purge': { args: { trashIds: string[] }; result: void }
  'vault:createFolder': { args: { parent: string; name: string }; result: { path: string } }

  'capture:save': { args: { text: string; source: 'quick-capture' | 'main-window' }; result: DocMeta }
  'capture:saveLog': { args: { text: string; start: string; end: string }; result: DocMeta }
  'capture:hideWindow': { args: void; result: void }
  'capture:resize': { args: { height: number }; result: void }

  /** 文档按当前路径读取；应用 ID 仅用于对话、任务等应用资料。 */
  'doc:get': { args: { ref: Ref }; result: Doc }
  'doc:create': { args: { dir?: string; title: string; body?: string; classification?: ClassificationPatch }; result: DocMeta }
  'doc:setClassification': { args: { ref: Ref; patch: ClassificationPatch }; result: DocMeta }
  'doc:saveBody': { args: { ref: Ref; body: string; baseHash: string }; result: { hash: string } }
  'doc:rename': { args: { ref: Ref; newName: string }; result: DocMeta }
  'doc:move': { args: { ref: Ref; toDir: string }; result: DocMeta }
  'doc:delete': { args: { ref: Ref }; result: { trashId: string } }
  'doc:setOccurredAt': { args: { ref: Ref; occurredAt: string | null }; result: DocMeta }
  'doc:setLogTime': { args: { ref: Ref; start: string; end: string }; result: DocMeta }
  'trash:list': { args: { limit?: number; offset?: number }; result: Paged<TrashItem> }
  'library:delete': { args: { path: string; scope: 'source' | 'entry' }; result: { trashId: string } }
  'doc:restore': { args: { trashId: string }; result: DocMeta }
  'doc:openExternal': { args: { path: string }; result: void }
  'doc:quickOpen': { args: { query: string; limit?: number }; result: DocMeta[] }
  'doc:resolveLink': { args: { from: string; target: string; kind?: 'markdown' | 'wiki' }; result: DocMeta }

  'content:directories': { args: { parentPath?: string; recursive?: boolean }; result: import('./files').DirectoryItem[] }
  'content:stats': { args: { scope?: ContentScope; filter?: SearchFilter; groupBy: 'folder' | 'tag' | 'date' | 'type' }; result: { total: number; groups: { key: string; count: number }[] } }
  'library:query': { args: LibraryQuery; result: Paged<LibraryItem> }
  'library:facets': { args: { scope?: ContentScope }; result: LibraryFacets }
  'library:resolve': { args: { path: string }; result: LibraryItem | null }

  'search:query': {
    args: { text?: string; filter?: SearchFilter; sort?: 'relevance' | 'time'; limit?: number; offset?: number }
    result: Paged<SearchHit>
  }

  'classify:inbox': { args: { limit?: number; offset?: number }; result: Paged<InboxItem> }
  'classify:accept': { args: { ref: Ref; kind: import('./pending').SuggestionKind; toDir?: string }; result: DocMeta }
  'classify:skip': { args: { ref: Ref; kind: import('./pending').SuggestionKind }; result: DocMeta }
  'classify:rerun': { args: { ref: Ref }; result: { jobId: string } }

  'taxonomy:create': { args: { kind: TermKind; name: string }; result: void }
  'taxonomy:remove': { args: { kind: TermKind; name: string; into?: string }; result: import('./files').BatchResult }
  'taxonomy:terms': { args: { kind: 'tag' | 'place' | 'person' }; result: TermInfo[] }
  'taxonomy:rename': { args: { kind: TermKind; from: string; to: string }; result: import('./files').BatchResult }
  'taxonomy:merge': { args: { kind: TermKind; from: string[]; into: string }; result: import('./files').BatchResult }
  'taxonomy:findSynonyms': { args: { kind: TermKind }; result: { jobId: string } }
  'taxonomy:synonyms': { args: void; result: SynonymGroup[] }
  'taxonomy:dismissSynonym': { args: { id: string }; result: void }

  'files:import': { args: { paths: string[]; toDir?: string }; result: { imported: string[]; skipped: { path: string; reason: string }[] } }
  'files:list': { args: { limit?: number; offset?: number }; result: Paged<FileItem> }
  'files:reprocess': { args: { path: string; force?: boolean; summaryPath?: string }; result: { jobId: string } }

  'timeline:day': { args: { date: string }; result: DayView }
  'timeline:daysWithRecords': { args: { month: string }; result: string[] }
  'timeline:generateDaily': { args: { date: string; force?: boolean }; result: { jobId: string } }

  'capabilities:changePlugin': { args: PluginChange; result: CapabilityCatalog }
  'capabilities:resources': { args: { owner: CapabilityOwner; id: string }; result: CapabilityResource[] }
  'capabilities:readResource': { args: { owner: CapabilityOwner; id: string; path: string }; result: string }
  'capabilities:patchResources': { args: { owner: CapabilityOwner; id: string; files: CapabilityFileInput[] }; result: CapabilityCatalog }
  'capabilities:setToolEnabled': { args: { id: string; enabled: boolean }; result: CapabilityCatalog }
  'capabilities:setAgentEnabled': { args: { id: string; enabled: boolean }; result: CapabilityCatalog }
  'capabilities:setTaskSkills': { args: Partial<import('./ai-tasks').TaskSkillBindings>; result: CapabilityCatalog }
  'capabilities:impact': { args: { owner: CapabilityOwner | 'agent' | 'tool'; id: string }; result: string[] }
  'capabilities:previewUpdate': { args: { owner: CapabilityOwner; id: string }; result: SkillImportPreview | PluginImportPreview | null }
  'capabilities:setPluginEnabled': { args: { id: string; enabled: boolean }; result: CapabilityCatalog }
  'capabilities:previewPluginImport': { args: void; result: PluginImportPreview | null }
  'capabilities:confirmPluginImport': { args: { token: string }; result: CapabilityCatalog }
  'capabilities:cancelPluginImport': { args: { token: string }; result: void }
  'capabilities:changeAgent': { args: AgentChange; result: CapabilityCatalog }
  'capabilities:changeSkill': { args: SkillChange; result: CapabilityCatalog }
  'capabilities:previewSkillImport': { args: void; result: SkillImportPreview | null }
  'capabilities:confirmSkillImport': { args: { token: string; name: string }; result: CapabilityCatalog }
  'capabilities:cancelSkillImport': { args: { token: string }; result: void }
  'capabilities:runs': { args: { text?: string; status?: RunRecord['status']; limit?: number; offset?: number }; result: Paged<RunRecord> }
  'capabilities:removeRun': { args: { runId: string }; result: void }
  'capabilities:catalog': { args: void; result: CapabilityCatalog }
  'agent:conversations': { args: { text?: string; limit?: number; offset?: number }; result: Paged<ConversationInfo> }
  'agent:create': { args: void; result: ConversationInfo }
  'agent:get': { args: { conversationId: string }; result: { info: ConversationInfo; messages: ChatMessage[]; context?: AssistantContext; running?: string; live?: ChatMessage } }
  'agent:send': { args: { conversationId: string; text: string; context?: AssistantContext; retryMessageId?: string }; result: { runId: string } }
  'agent:setReasoning': { args: { conversationId: string; effort: ReasoningEffort | null }; result: AssistantContext }
  'agent:confirm': { args: { runId: string; requestId: string; approved: boolean }; result: void }
  'agent:abort': { args: { runId: string }; result: void }
  'agent:rename': { args: { conversationId: string; title: string }; result: void }
  'agent:delete': { args: { conversationId: string }; result: void }
  'agent:export': { args: { conversationId: string; format: ConversationExportFormat }; result: { path: string } | null }

  'jobs:list': { args: { state?: JobState; states?: JobState[]; limit?: number; offset?: number }; result: Paged<JobInfo> }
  'jobs:retry': { args: { jobId: string }; result: void }
  'jobs:cancel': { args: { jobId: string }; result: void }

  'settings:get': { args: void; result: Settings }
  'settings:reasoning': { args: { baseUrl: string; model: string }; result: ResolvedReasoning }
  'settings:modelBudget': { args: { baseUrl: string; model: string; contextWindow?: number; compactionThreshold?: CompactionThreshold; reasoningEffort?: ReasoningEffort }; result: ResolvedModelBudget }
  'settings:set': { args: SettingsInput; result: Settings }
  'settings:testModel': { args: { baseUrl?: string; apiKey?: string; model?: string; reasoningEffort?: ReasoningEffort; contextWindow?: number; compactionThreshold?: CompactionThreshold }; result: ModelTestResult }
}

export type Channel = keyof IpcContract
export type Args<K extends Channel> = IpcContract[K]['args']
export type Ret<K extends Channel> = IpcContract[K]['result']

/** 主进程推送给界面的事件 */
export interface EventContract {
  'library:pinsChanged': null
  'commands:changed': null
  'extensions:changed': null
  'vault:changed': { changes: VaultChange[] }
  'storage:changed': StorageChange
  'doc:updated': DocMeta
  'inbox:count': { count: number }
  'jobs:updated': JobsSummary & { job?: JobInfo }
  'files:changed': null
  'agent:event': AgentEvent
  'agent:changed': { conversationId: string; deleted: boolean }
  'capabilities:changed': null
  'settings:changed': Settings
  'taxonomy:changed': null
  'model:status': { state: ModelState; message?: string }
  'capture:shown': null
  'hotkey:conflict': { hotkey: string }
}

export type EventName = keyof EventContract

export const CHANNELS: readonly Channel[] = [
  'library:pins', 'library:setPinned', 'library:reorderPin',
  'commands:list', 'commands:execute', 'extensions:configuration', 'extensions:catalog', 'extensions:previewImport', 'extensions:confirmImport', 'extensions:cancelImport', 'extensions:setEnabled', 'extensions:saveProfile', 'extensions:removeProfile', 'extensions:uninstall', 'extensions:readTemplate', 'extensions:copyTemplate', 'extensions:previewDateNote', 'extensions:previewWorkReport', 'shortcuts:get', 'shortcuts:set',
  'extensions:previewAiPlugin', 'extensions:confirmAiPlugin', 'extensions:cancelAiPlugin',
  'maintenance:usage', 'maintenance:clearTemporary', 'maintenance:optimizeDatabases',
  'app:info', 'app:status',
  'vault:refreshIndex', 'doc:properties', 'doc:patchProperties', 'doc:editText', 'content:move', 'links:list',
  'vault:status', 'vault:pick', 'vault:open', 'vault:tree', 'vault:rebuildIndex', 'vault:createFolder', 'folder:move', 'folder:delete', 'folder:restore', 'trash:purge',
  'capture:save', 'capture:saveLog', 'capture:hideWindow', 'capture:resize',
  'doc:setOccurredAt', 'doc:setLogTime', 'trash:list', 'library:delete', 'doc:get', 'doc:create', 'doc:setClassification', 'doc:saveBody', 'doc:rename', 'doc:move', 'doc:delete', 'doc:restore', 'doc:openExternal', 'doc:quickOpen', 'doc:resolveLink',
  'content:directories', 'content:stats',
  'library:query', 'library:facets', 'library:resolve', 'search:query',
  'classify:inbox', 'classify:accept', 'classify:skip', 'classify:rerun',
  'taxonomy:create', 'taxonomy:remove', 'taxonomy:terms', 'taxonomy:rename', 'taxonomy:merge',
  'taxonomy:findSynonyms', 'taxonomy:synonyms', 'taxonomy:dismissSynonym',
  'files:import', 'files:list', 'files:reprocess',
  'timeline:day', 'timeline:daysWithRecords', 'timeline:generateDaily',
  'capabilities:changePlugin', 'capabilities:resources', 'capabilities:readResource', 'capabilities:patchResources', 'capabilities:setToolEnabled', 'capabilities:setAgentEnabled', 'capabilities:setTaskSkills', 'capabilities:impact', 'capabilities:previewUpdate',
  'capabilities:setPluginEnabled', 'capabilities:previewPluginImport', 'capabilities:confirmPluginImport', 'capabilities:cancelPluginImport',
  'capabilities:changeAgent', 'capabilities:changeSkill', 'capabilities:previewSkillImport', 'capabilities:confirmSkillImport', 'capabilities:cancelSkillImport', 'capabilities:runs', 'capabilities:removeRun', 'capabilities:catalog', 'agent:conversations', 'agent:create', 'agent:get', 'agent:send', 'agent:setReasoning', 'agent:confirm', 'agent:abort', 'agent:rename', 'agent:delete', 'agent:export',
  'jobs:list', 'jobs:retry', 'jobs:cancel',
  'settings:get', 'settings:set', 'settings:testModel', 'settings:modelBudget', 'settings:reasoning',
]

export const EVENTS: readonly EventName[] = ['library:pinsChanged', 'commands:changed', 'extensions:changed', 'storage:changed', 'vault:changed', 'doc:updated', 'inbox:count', 'jobs:updated', 'files:changed', 'agent:event', 'agent:changed', 'taxonomy:changed', 'settings:changed', 'capabilities:changed', 'model:status', 'capture:shown', 'hotkey:conflict']

/** 预加载脚本暴露给界面的接口（window.jot） */
export interface JotBridge {
  invoke<K extends Channel>(channel: K, ...args: Args<K> extends void ? [] : [Args<K>]): Promise<Result<Ret<K>>>
  on<E extends EventName>(event: E, listener: (data: EventContract[E]) => void): () => void
  /** 拖进窗口的文件在磁盘上的完整路径；拿不到时返回空串。参数是浏览器的 File 对象。 */
  pathForFile(file: unknown): string
}
