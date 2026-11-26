import type { AssistantContext } from './assistant'
import type { ChatMessage, ConversationInfo } from './types'

export type ConversationExportFormat = 'markdown' | 'jsonl'
export interface ConversationSummary {
  mode: 'normal' | 'strict'
  throughMessageId: string
  summary: string
  updatedAt: string
}
/** 完整已保存问答及接续摘要；不包含密钥或运行中的瞬时状态。 */
export interface ConversationSnapshot {
  info: ConversationInfo
  context?: AssistantContext
  messages: ChatMessage[]
  summaries: ConversationSummary[]
  exportedAt: string
}
