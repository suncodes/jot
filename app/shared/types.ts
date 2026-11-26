import type { ReasoningEffort, ResolvedReasoning } from './reasoning'
import type { ContentRole, ContentScope } from './storage'
import type { ContentSuggestion, SuggestionKind } from './pending'
import type { MessagePart, ToolCall, TurnContext } from './assistant'
import type { CompactionThreshold, ContextBudget, ModelBudgetOverrides } from './model-budget'
// 主进程与界面共用的数据类型。见 docs/architecture.md。

export type DocType = 'idea' | 'log' | 'note' | 'file' | 'source-summary' | 'daily'
export interface Classification {
  tags: string[]
  place?: string
  people: string[]
}

export interface DocMeta {
  notUpdated?: { path: string; message: string }[]
  /** 文件当前可读属性；未知键保持原值，索引不是权威副本。 */
  properties?: Record<string, unknown>
  invalidProperties?: boolean
  role?: ContentRole
  path: string
  type: DocType
  title: string
  created: string
  modified: string
  size?: number
  generatedByAi: boolean
  classification: Classification
  occurredAt?: string
  start?: string
  end?: string
  sourcePath?: string
  sourceMissing?: boolean
}

export interface Doc extends DocMeta {
  body: string
  /** 整个文件内容的指纹，保存时用来判断文件是否被别处改过 */
  hash: string
  /** 正文第一行在文件里的行号（从 1 开始）；片段的行号是文件行号 */
  bodyStartLine: number
  /** 是否是能在编辑器里打开的文本 */
  editable: boolean
}

export interface VaultChange {
  kind: 'add' | 'change' | 'remove'
  path: string
}

export interface Ref { path: string }

export interface Chunk {
  chunkId: string
  path: string
  lineStart: number
  lineEnd: number
  text: string
  generatedByAi: boolean
  /** 当前读取时的摘要来源路径；不依赖索引正文或历史身份。 */
  sourcePath?: string
}

export interface SearchFilter {
  scope?: ContentScope
  /** 索引内部的候选路径集合，不从 IPC 或模型接收 */
  objectPaths?: string[]
  /** 内部材料边界：当前文件／目录的并集，不接受模型覆盖。 */
  materials?: { kind: 'file' | 'folder'; value: string }[]
  types?: DocType[]
  tags?: string[]
  place?: string
  people?: string[]
  /** 匹配当前日期候选：发生、创建或最后修改；显式时间口径使用 scope.time。 */
  from?: string
  to?: string
}

export interface SearchHit {
  doc: DocMeta
  chunk: Chunk
  snippet: string
  /** snippet 内的高亮区间 [起, 止) */
  highlights: [number, number][]
}

export interface Page {
  limit?: number
  offset?: number
}

export interface Paged<T> {
  items: T[]
  total: number
}

export interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  children?: TreeNode[]
}

export interface VaultStatus {
  open: boolean
  path?: string
}

export interface ModelSettings extends ModelBudgetOverrides {
  protocol: import('./model-protocol').ModelProtocol
  baseUrl: string
  model: string
  hasApiKey: boolean
  reasoningEffort: ReasoningEffort
}

export type WindowCloseBehavior = 'tray' | 'quit'

export interface Settings {
  model: ModelSettings
  classify: { enabled: boolean }
  capture: { hotkey: string; launchAtLogin: boolean }
  window: { closeBehavior: WindowCloseBehavior }
  daily: { enabled: boolean; time: string }
  maintenance: { trashRetentionDays: 0 | 30 }
  appearance: { theme: 'system' | 'dark' | 'light' }
  layout: { sideWidth: number; agentWidth: number; sideCollapsed: boolean; agentCollapsed: boolean }
}

/** 写入设置时的输入：密钥只能写入，不能读回 */
export interface SettingsInput {
  model?: { protocol?: import('./model-protocol').ModelProtocol; baseUrl?: string; model?: string; apiKey?: string; contextWindow?: number | null; compactionThreshold?: CompactionThreshold | null; reasoningEffort?: ReasoningEffort }
  classify?: Partial<Settings['classify']>
  capture?: Partial<Settings['capture']>
  window?: Partial<Settings['window']>
  daily?: Partial<Settings['daily']>
  maintenance?: Partial<Settings['maintenance']>
  appearance?: Partial<Settings['appearance']>
  layout?: Partial<Settings['layout']>
}

export interface ModelTestResult {
  ok: boolean
  latencyMs?: number
  message?: string
}

export type JobType = 'classify' | 'summarize-file' | 'daily' | 'reindex' | 'find-synonyms'
export type JobState = 'queued' | 'running' | 'waiting-model' | 'failed' | 'done' | 'cancelled'

export interface AiExecution {
  model: string
  skillId?: string
  reasoning?: ResolvedReasoning
}
export interface JobInfo {
  jobId: string
  type: JobType
  target?: string
  state: JobState
  attempts: number
  nextRunAt?: string
  error?: string
  /** 最近一次成功处理的简短说明，不保存材料全文。 */
  note?: string
  execution?: AiExecution
}

export interface JobsSummary {
  running: number
  queued: number
  failed: number
  waitingModel: number
}

export interface InboxItem {
  doc: DocMeta
  preview: string
  reasons: SuggestionKind[]
  suggestions: ContentSuggestion[]
  /** 此内容最近一次整理任务；等待／失败不等于缺少属性。 */
  analysis?: JobInfo
}

export interface TermInfo {
  name: string
  state: 'official' | 'candidate'
  count: number
}

/** 修改归类时提交的内容：给出的属性会被覆盖，null 表示清空 */
export interface ClassificationPatch {
  tags?: string[]
  place?: string | null
  people?: string[]
}

export type FileState = 'unprocessed' | 'queued' | 'processing' | 'done' | 'waiting-model' | 'failed' | 'unsupported'

/** 文件归档里的一份原件 */
export interface FileItem {
  role?: ContentRole
  path: string
  size: number
  addedAt: string
  state: FileState
  /** 失败的原因 */
  error?: string
  /** 需要你知道的情况，例如“原件已更新，摘要页被你改过，没有自动覆盖” */
  note?: string
  summaryPath?: string
  summaryPaths?: string[]
  classification?: Classification
  /** 是否是能在软件里打开的文本 */
  text: boolean
}

/** 内容查询中的当前原件投影，状态只补充处理进度。 */
export interface LibrarySource extends FileItem { missing: boolean; modified: string }

export interface ConversationInfo {
  /** 历史列表中最近一次提问的摘要；创建及单条查询可不返回。 */
  preview?: string
  conversationId: string
  title: string
  createdAt: string
  updatedAt: string
}

/** 回答里的一处出处 */
export interface Citation {
  /** 回答文本里的片段编号，写法是 [^编号] */
  marker: string
  /** 编号是否对应助手在这次对话里实际读到的片段 */
  valid: boolean
  chunk?: Chunk
  /** 引用的是 AI 生成的页面时，它依据的原件 */
  basedOn?: string[]
}

export interface ChatMessage {
  messageId: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  /** 实际开始时间与总耗时；旧消息可能没有记录。 */
  startedAt?: string
  durationMs?: number
  toolCalls?: ToolCall[]
  parts?: MessagePart[]
  context?: TurnContext
  runId?: string
  /** 已从运行记录列表移除，原对话仍保留。 */
  runHidden?: boolean
  /** 正在运行的消息检查点；启动恢复后转为中断，旧消息可缺省。 */
  runState?: 'running' | 'interrupted'
  citations?: Citation[]
  budget?: ContextBudget
  /** 只在本轮必须等待后台摘要时显示，不持久化运行中状态。 */
  waitingForCompaction?: boolean
  /** 这次回答没有完成的原因 */
  error?: string
}

export type AgentEvent =
  | { runId: string; conversationId: string; type: 'text'; delta: string }
  | { runId: string; conversationId: string; type: 'tool-start'; name: string; summary: string; call?: ToolCall }
  | { runId: string; conversationId: string; type: 'tool-update'; call: ToolCall }
  | { runId: string; conversationId: string; type: 'tool-end'; name: string; summary: string; ok: boolean; call?: ToolCall }
  | { runId: string; conversationId: string; type: 'compacting'; waiting: boolean }
  | { runId: string; conversationId: string; type: 'budget'; budget: ContextBudget }
  | { runId: string; conversationId: string; type: 'done'; message: ChatMessage }
  | { runId: string; conversationId: string; type: 'error'; error: { code: string; message: string }; message?: ChatMessage }
  | { runId: string; conversationId: string; type: 'aborted'; message?: ChatMessage }

export interface TimelineEntry {
  conversationId?: string
  messageId?: string
  kind: 'idea' | 'log' | 'file' | 'conversation' | 'note'
  basis: 'recorded' | 'occurred' | 'created' | 'updated' | 'question'
  time: string
  created: string
  end?: string
  title: string
  preview: string
  path?: string
  sourcePath?: string
  classification?: Classification
}
export interface DayView {
  date: string
  stats: { ideas: number; logs: number; files: number; notes: number; conversations: number }
  entries: TimelineEntry[]
  daily?: { path: string; body: string; generatedAt: string }
  dailyJob?: { state: JobState; error?: string }
}

export type TermKind = 'tag' | 'place' | 'person'

/** 疑似同义的一组词，等你确认是否合并 */
export interface SynonymGroup {
  id: string
  kind: TermKind
  names: string[]
  /** 建议保留的那个名字 */
  suggested: string
  reason: string
}

export type ModelState = 'ok' | 'not-configured' | 'unavailable'

export interface AppInfo {
  version: string
  /** 是否开发模式（未打包） */
  dev: boolean
  platform: string
}

/** 分类浏览中的内容身份。原件和摘要共用 path（原件路径）。 */
export type LibraryKind = 'record' | 'note' | 'file'
export interface LibraryQuery extends Page {
  scope?: ContentScope
  /** 与搜索共用的属性／日期筛选；scope 由集合选择单独确定。 */
  filter?: Omit<SearchFilter, 'scope' | 'objectPaths' | 'materials'>
  pending?: boolean
  kind?: LibraryKind
  text?: string
  sort?: 'updated' | 'created' | 'name'
  fileState?: FileState
  /** 内部定位可使用原件、摘要或笔记路径。 */
  path?: string
}
/** 筛选候选来自完整的合并内容集合，不受列表分页影响。 */
export interface LibraryFacets {
  months: string[]
  tags: { name: string; count: number }[]
}
export interface LibraryItem {
  path: string
  title: string
  kind: LibraryKind
  created: string
  modified: string
  classification: Classification
  preview: string
  summaryPath?: string
  summaryPaths?: string[]
  sourceMissing?: boolean
  file?: FileItem
}

/** 目录操作后的路径映射，用于同步打开的标签页。 */
export interface FolderChange { path: string; paths: { from: string; to: string }[]; notUpdated?: { path: string; message: string }[] }
/** 一次可恢复的删除；组合条目包含原件和全部关联摘要。 */
export interface TrashItem {
  kind?: 'directory'
  trashId: string
  originalPath: string
  paths: string[]
  deletedAt: string
}
