import type { ManagedAgent, ManagedSkill } from './capabilities'
import type { ReasoningEffort, ResolvedReasoning } from './reasoning'

export interface MaterialReference {
  kind: 'file' | 'folder'
  /** 库内相对路径或明确指定的磁盘绝对路径。 */
  value: string
  title: string
  /** 目录默认只含物理子树，显式开启才增加一跳相关记录。 */
}
export interface AssistantContext {
  /** 省略表示跟随全局默认；显式选择按配置 ID 保存。 */
  modelId?: string
  agentId: string
  references: MaterialReference[]
  strict: boolean
  skillIds: string[]
  reasoningEffort?: ReasoningEffort
  /** 此覆盖对应的模型身份，接口或模型变化后恢复跟随。 */
  reasoningModel?: string
}
/** 本轮实际配置与路径选择，不保存文件正文或精确重试材料。 */
export interface TurnContext extends AssistantContext {
  agent: ManagedAgent
  model?: string
  modelUse?: import('./models').ModelUse
  reasoning?: ResolvedReasoning
  skills: Pick<ManagedSkill, 'id' | 'name' | 'title'>[]
}
export interface ToolConfirmation {
  id: string
  title: string
  targets: { path: string; action: 'overwrite' | 'trash' | 'unlink' | 'purge' | 'delete-conversation' | 'maintenance' | 'capability-delete' | 'capability-overwrite' }[]
  state: 'pending' | 'approved' | 'rejected'
}
export type ToolErrorKind = 'json' | 'validation' | 'execution'
export interface ToolCall {
  errorKind?: ToolErrorKind
  id?: string
  name: string
  summary: string
  ok?: boolean
  input?: unknown
  output?: string
  durationMs?: number
  confirmation?: ToolConfirmation
}
export type MessagePart = { type: 'text'; text: string } | { type: 'tool'; call: ToolCall }
export interface RunRecord {
  id: string
  conversationId: string
  title: string
  time: string
  status: 'completed' | 'failed' | 'stopped' | 'interrupted'
  question: string
  message: import('./types').ChatMessage
}
