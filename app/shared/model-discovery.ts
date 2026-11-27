import type { ModelProtocol } from './model-protocol'

/** 使用渠道表单值获取候选，不写入渠道配置或切换默认模型。 */
export interface ModelDiscoveryInput {
  channelId?: string
  protocol: ModelProtocol
  baseUrl: string
  apiKey?: string
}
export interface DiscoveredModel {
  id: string
  name: string
}
export interface ModelDiscoveryResult {
  models: DiscoveredModel[]
  /** 服务返回数量过大时明确告知，只展示已取回的候选。 */
  truncated: boolean
}
