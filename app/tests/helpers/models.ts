import type { ModelConfig } from '../../electron/env'
import type { Settings } from '../../shared/types'
import { resolveModelSettings } from '../../shared/models'
import type { ModelCatalogInput } from '../../shared/models'

/** 测试按完整渠道契约提交；可在虚构当前配置上修改某个模型参数。 */
export function modelSettings(config: Partial<ModelConfig>, settings?: Settings): { models: ModelCatalogInput } {
  const catalog = settings?.models
  const current = catalog?.channels.find(channel => channel.models.some(model => model.id === catalog.defaultModelId)) ?? catalog?.channels[0]
  const profile = current?.models.find(model => model.id === catalog?.defaultModelId) ?? current?.models[0]
  const identityChanged = config.model !== undefined && config.model !== profile?.model || config.baseUrl !== undefined && config.baseUrl !== current?.baseUrl || config.protocol !== undefined && config.protocol !== current?.protocol
  const model = { ...profile, id: profile?.id ?? 'fixture-model', name: profile?.name ?? '虚构模型', model: config.model ?? profile?.model ?? 'fixture', reasoningEffort: config.reasoningEffort ?? (identityChanged ? 'auto' : profile?.reasoningEffort ?? 'auto'),
    ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}) }
  if (identityChanged && config.contextWindow === undefined) delete model.contextWindow
  if (config.compactionThreshold !== undefined) model.compactionThreshold = config.compactionThreshold
  return { models: { defaultModelId: model.id, channels: [{
    id: current?.id ?? 'fixture-channel', name: current?.name ?? '虚构渠道', protocol: config.protocol ?? current?.protocol ?? 'openai-completions', baseUrl: config.baseUrl ?? current?.baseUrl ?? 'https://fixture.invalid/v1',
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}), models: [model],
  }] } }
}

export function defaultModel(settings: Settings) {
  return resolveModelSettings(settings.models) ?? { model: '', hasApiKey: false, reasoningEffort: 'auto' as const, contextWindow: undefined, compactionThreshold: undefined }
}
