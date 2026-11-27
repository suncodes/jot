import { z } from 'zod'
import { MODEL_PROTOCOLS } from '@shared/model-protocol'
import { MODEL_BUDGET_BOUNDS } from '@shared/model-budget'
import { REASONING_EFFORTS } from '@shared/reasoning'

export const modelId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)
export const modelBaseUrl = z.string().trim().url().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}, '请填写不含凭证或查询参数的 HTTP(S) 基础地址')
export const modelDiscoveryInput = z.object({
  channelId: modelId.optional(),
  protocol: z.enum(MODEL_PROTOCOLS),
  baseUrl: modelBaseUrl,
  apiKey: z.string().max(16000).optional(),
}).strict()
export const modelBudgetFields = {
  contextWindow: z.number().int().min(MODEL_BUDGET_BOUNDS.contextWindow.min).max(MODEL_BUDGET_BOUNDS.contextWindow.max).optional(),
  compactionThreshold: z.union([z.literal(0.6), z.literal(0.7), z.literal(0.8)]).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS),
}
export const modelCatalogInput = z.object({
  channels: z.array(z.object({
    id: modelId,
    name: z.string().trim().min(1).max(100),
    protocol: z.enum(MODEL_PROTOCOLS),
    baseUrl: modelBaseUrl,
    apiKey: z.string().max(16000).optional(),
    models: z.array(z.object({
      id: modelId, name: z.string().trim().max(100), model: z.string().trim().min(1).max(200), ...modelBudgetFields,
    }).strict()).max(100),
  }).strict()).max(50),
  defaultModelId: modelId.nullable(),
}).strict().superRefine((catalog, context) => {
  const channels = new Set<string>(), models = new Set<string>()
  for (const channel of catalog.channels) {
    if (channels.has(channel.id)) context.addIssue({ code: 'custom', message: '渠道 ID 重复' })
    channels.add(channel.id)
    for (const model of channel.models) {
      if (models.has(model.id)) context.addIssue({ code: 'custom', message: '模型配置 ID 重复' })
      models.add(model.id)
    }
  }
  if (catalog.defaultModelId && !models.has(catalog.defaultModelId)) context.addIssue({ code: 'custom', message: '全局默认模型不存在' })
})
