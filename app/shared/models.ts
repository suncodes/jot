import type { ModelProtocol } from './model-protocol'
import type { ModelBudgetOverrides } from './model-budget'
import type { ReasoningEffort } from './reasoning'

/** 新建及更换模型时的表单预选值；不代表服务端能力检测结果。 */
export const MODEL_PROFILE_DEFAULTS = { reasoningEffort: 'high', contextWindow: 262144 } as const

export interface ModelProfile extends ModelBudgetOverrides {
  id: string
  name: string
  model: string
  reasoningEffort: ReasoningEffort
}
export interface ModelChannel {
  id: string
  name: string
  protocol: ModelProtocol
  baseUrl: string
  hasApiKey: boolean
  models: ModelProfile[]
}
export interface ModelCatalog {
  channels: ModelChannel[]
  defaultModelId: string | null
}
export interface ModelChannelInput extends Omit<ModelChannel, 'hasApiKey'> {
  /** 省略保留该渠道密钥；空字符串明确清除。 */
  apiKey?: string
}
export interface ModelCatalogInput {
  channels: ModelChannelInput[]
  defaultModelId: string | null
}
export interface ResolvedModelSettings extends ModelProfile {
  channelId: string
  channelName: string
  protocol: ModelProtocol
  baseUrl: string
  hasApiKey: boolean
}
export interface ModelUse {
  id?: string
  channelId?: string
  channelName?: string
  name?: string
  protocol?: ModelProtocol
  model: string
}
export function resolveModelSettings(catalog: ModelCatalog, modelId = catalog.defaultModelId): ResolvedModelSettings | null {
  if (!modelId) return null
  for (const channel of catalog.channels) {
    const profile = channel.models.find(model => model.id === modelId)
    if (profile) return { ...profile, channelId: channel.id, channelName: channel.name, protocol: channel.protocol, baseUrl: channel.baseUrl, hasApiKey: channel.hasApiKey }
  }
  return null
}
export function modelOptions(catalog: ModelCatalog): { value: string; label: string; group: string }[] {
  return catalog.channels.flatMap(channel => channel.models.map(model => ({ value: model.id, label: channel.name + ' / ' + (model.name || model.model), group: channel.name })))
}
