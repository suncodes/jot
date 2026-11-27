import { JotError } from '@shared/result'
import { protocolBaseUrl } from '@shared/model-protocol'
import type { DiscoveredModel, ModelDiscoveryInput, ModelDiscoveryResult } from '@shared/model-discovery'
import { modelDiscoveryInput } from '../settings/model-schema'

const MAX_MODELS = 10000
const MAX_PAGES = 100
const DEADLINE_MS = 20000

/** 只列出服务提供的候选；模型可用性、工具和推理支持仍由实际连接测试确认。 */
export async function discoverModels(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
  const parsed = modelDiscoveryInput.safeParse(input)
  if (!parsed.success) throw new JotError('INVALID_INPUT', parsed.error.issues[0]?.message ?? '渠道连接配置无效')
  const config = parsed.data, anthropic = config.protocol === 'anthropic-messages'
  const url = new URL(protocolBaseUrl(config) + (anthropic ? '/v1/models' : '/models'))
  const headers: Record<string, string> = { accept: 'application/json' }
  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01'
    if (config.apiKey) headers['x-api-key'] = config.apiKey
    url.searchParams.set('limit', '100')
  } else if (config.apiKey) headers.authorization = 'Bearer ' + config.apiKey
  const models = new Map<string, DiscoveredModel>(), cursors = new Set<string>()
  const signal = AbortSignal.timeout(DEADLINE_MS)
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      // 不跟随跳转向其他地址发送渠道凭证，不自动尝试其他协议或路径。
      const response = await fetch(url, { headers, signal, redirect: 'error' })
      if (!response.ok) {
        await response.body?.cancel()
        const hint = response.status === 401 || response.status === 403 ? '请核对该渠道密钥及模型列表权限。'
          : response.status === 404 || response.status === 405 ? '服务可能未提供模型列表接口，请核对基础地址（OpenAI 通常包含 /v1），或手动添加模型。'
          : response.status === 429 ? '请求过于频繁，请稍后再试。' : '请稍后再试或手动添加模型。'
        throw new JotError('LLM_UNAVAILABLE', '获取模型失败（HTTP ' + response.status + '）。' + hint)
      }
      // 部分代理未声明 JSON 类型，以实际正文解析结果为准。
      let body: { data?: unknown; has_more?: unknown; last_id?: unknown }
      try { body = await response.json() as typeof body }
      catch (error) {
        if (signal.aborted) throw error
        throw new JotError('LLM_BAD_OUTPUT', '模型列表不是有效 JSON，可能访问到了网页。请核对基础地址（OpenAI 通常包含 /v1），或手动添加模型。')
      }
      if (!body || !Array.isArray(body.data)) throw new JotError('LLM_BAD_OUTPUT', '模型列表格式不受支持，预期 data 数组。可手动添加模型。')
      for (const entry of body.data) {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.trim().length > 200) {
          throw new JotError('LLM_BAD_OUTPUT', '模型列表包含无效的模型标识，可手动添加模型。')
        }
        const id = entry.id.trim()
        const name = typeof entry.display_name === 'string' ? entry.display_name : typeof entry.name === 'string' ? entry.name : id
        models.set(id, { id, name: name.trim().slice(0, 100) || id })
        if (models.size >= MAX_MODELS) return result(models, true)
      }
      if (body.has_more !== true) return result(models, false)
      const cursor = typeof body.last_id === 'string' && body.last_id ? body.last_id : body.data.at(-1)?.id
      if (!cursor || typeof cursor !== 'string' || cursors.has(cursor)) throw new JotError('LLM_BAD_OUTPUT', '模型列表分页未能继续，服务返回了重复或缺失的分页标识。可手动添加模型。')
      cursors.add(cursor)
      url.searchParams.set(anthropic ? 'after_id' : 'after', cursor)
    }
    return result(models, true)
  } catch (error) {
    if (error instanceof JotError) throw error
    throw new JotError('LLM_UNAVAILABLE', signal.aborted ? '获取模型超时，请稍后重试或手动添加模型。' : '无法获取模型列表，请检查网络、基础地址和渠道密钥，或手动添加模型。')
  }
}
function result(models: Map<string, DiscoveredModel>, truncated: boolean): ModelDiscoveryResult {
  return { models: [...models.values()].sort((left, right) => left.id.localeCompare(right.id)), truncated }
}
