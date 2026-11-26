import { COMMON_REASONING_EFFORTS, REASONING_EFFORTS, type ReasoningEffort, type ResolvedReasoning } from '@shared/reasoning'
import { JotError } from '@shared/result'
import type { ModelConfig } from '../env'
import { matchesModelProtocol, type ModelEndpoint } from '@shared/model-protocol'

export interface ReasoningModel {
  id: string; baseUrl: string; api?: string; reasoning?: boolean
  thinkingLevelMap?: Partial<Record<Exclude<ReasoningEffort, 'auto'>, string | null>>
  compat?: { supportsReasoningEffort?: boolean; [key: string]: unknown }
}
const endpoint = (value: string) => { try { return new URL(value).origin } catch { return '' } }
export { reasoningModelKey as modelIdentity } from '@shared/reasoning'

/** 只采用同来源、精确标识且适用于当前协议的资料，不从代理模型名推断能力。 */
export function trustedModel(config: ModelEndpoint, models: readonly ReasoningModel[]): ReasoningModel | undefined {
  return models.find(model => model.id === config.model && !!endpoint(config.baseUrl)
    && endpoint(model.baseUrl) === endpoint(config.baseUrl)
    && matchesModelProtocol(config, model.api))
}
export function resolveReasoning(config: ModelEndpoint & Pick<ModelConfig, 'reasoningEffort'>, models: readonly ReasoningModel[],
  override?: ReasoningEffort, internal = false): ResolvedReasoning {
  const known = trustedModel(config, models)
  const supported: ReasoningEffort[] = known
    ? ['auto', ...REASONING_EFFORTS.filter((effort): effort is Exclude<ReasoningEffort, 'auto'> => effort !== 'auto')
      .filter(effort => !!known.reasoning && known.thinkingLevelMap?.[effort] !== null
        && (['low', 'medium', 'high'].includes(effort) || typeof known.thinkingLevelMap?.[effort] === 'string'))]
    : [...COMMON_REASONING_EFFORTS]
  const requested = internal ? known && supported.includes('low') ? 'low' : 'auto' : override ?? config.reasoningEffort ?? 'auto'
  if (!supported.includes(requested)) throw new JotError('INVALID_INPUT', '当前模型没有声明支持此推理强度：' + requested + '。请选择模型默认或支持的档位。')
  return { requested, supported, availability: known ? 'known' : 'unverified',
    source: internal ? 'internal' : override !== undefined ? 'conversation' : requested === 'auto' ? 'model-default' : 'global' }
}

/** 兼容层可能在默认档自动添加关闭开关；发送前清除，auto严格遵循服务端默认。 */
export function cleanReasoningPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload }
  for (const key of ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'thinking_budget', 'thinking_budget_tokens', 'thinking_token_budget']) delete result[key]
  if (result.output_config && typeof result.output_config === 'object') {
    const { effort: _effort, ...other } = result.output_config as Record<string, unknown>
    if (Object.keys(other).length) result.output_config = other
    else delete result.output_config
  }
  for (const field of ['chat_template_kwargs', 'chat_template_args']) if (result[field] && typeof result[field] === 'object') {
    const values = { ...result[field] as Record<string, unknown> }
    for (const key of ['enable_thinking', 'thinking', 'thinking_budget', 'thinking_budget_tokens', 'thinking_token_budget', 'reasoning_effort']) delete values[key]
    if (Object.keys(values).length) result[field] = values
    else delete result[field]
  }
  return result
}
export function sentReasoning(resolved: ResolvedReasoning, payload: Record<string, unknown>): ResolvedReasoning {
  if (resolved.requested === 'auto') return { ...resolved }
  const names = ['reasoning_effort', 'reasoning', 'thinking', 'output_config', 'enable_thinking', 'thinking_budget', 'thinking_budget_tokens', 'thinking_token_budget', 'chat_template_kwargs', 'chat_template_args']
  const parameters = Object.fromEntries(names.filter(name => payload[name] !== undefined).map(name => [name, structuredClone(payload[name])]))
  return { ...resolved, ...(Object.keys(parameters).length ? { parameters } : {}) }
}
export function reasoningFailure(message: string, effort?: ReasoningEffort): JotError {
  const rejected = effort && effort !== 'auto' && /reasoning[_ -]?effort|thinking[_ -]?level|enable_thinking|reasoning\.effort|output_config|budget_tokens|thinking.*(unsupported|not supported|invalid)/i.test(message)
    && /400|422|unsupported|not supported|invalid|not allowed|unknown|不支持|无效/i.test(message)
  return rejected ? new JotError('LLM_REASONING_UNSUPPORTED', '模型接口拒绝请求的推理强度 ' + effort + '。请调整档位后重试；未自动降档。' + message.slice(0, 200))
    : new JotError('LLM_UNAVAILABLE', message)
}
