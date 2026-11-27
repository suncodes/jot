// 全局与单次对话共用的推理强度契约。
export const REASONING_EFFORTS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]
export type ExplicitReasoningEffort = Exclude<ReasoningEffort, 'auto'>
export const COMMON_REASONING_EFFORTS: readonly ReasoningEffort[] = ['auto', 'low', 'medium', 'high']

export interface ReasoningSelection {
  reasoningEffort?: ReasoningEffort
}
export interface ResolvedReasoning {
  requested: ReasoningEffort
  source: 'model-default' | 'global' | 'conversation' | 'internal'
  supported: readonly ReasoningEffort[]
  availability: 'known' | 'unverified'
  /** 模型默认没有此字段；实际适配参数在发送边界记录。 */
  parameters?: Record<string, unknown>
  /** 只有服务端明确返回时才记录，不以请求成功推断生效。 */
  reported?: string
}

import { DEFAULT_MODEL_PROTOCOL, type ModelEndpoint } from './model-protocol'

export const reasoningModelKey = (config: ModelEndpoint): string => (config.id ?? '') + '|' + (config.protocol ?? DEFAULT_MODEL_PROTOCOL) + '|' + config.baseUrl.replace(/\/+$/, '') + '|' + config.model
