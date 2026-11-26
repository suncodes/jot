import { DEFAULT_COMPACTION_THRESHOLD, safetyTokens, type ContextBudget, type ModelBudgetOverrides, type ResolvedModelBudget } from '@shared/model-budget'
import type { ChatMessage } from '@shared/types'
import type { ReasoningEffort } from '@shared/reasoning'
import { matchesModelProtocol, type ModelEndpoint } from '@shared/model-protocol'

interface CatalogModel { id: string; baseUrl: string; api?: string; contextWindow: number; maxTokens: number }
export type ModelLimits = ResolvedModelBudget

/** 只信任同接口来源、精确模型标识的 SDK 资料；代理别名和未知模型不猜窗口。 */
export function resolveModelLimits(config: ModelBudgetOverrides & ModelEndpoint & { reasoningEffort?: ReasoningEffort }, catalog: readonly CatalogModel[]): ModelLimits {
  const origin = (url: string): string => { try { return new URL(url).origin } catch { return '' } }
  const endpoint = origin(config.baseUrl)
  const known = catalog.filter(entry => endpoint && entry.id === config.model && origin(entry.baseUrl) === endpoint
    && matchesModelProtocol(config, entry.api)
    && entry.contextWindow > 0 && entry.maxTokens > 0)
  const window = config.contextWindow ?? (known.length ? Math.min(...known.map(entry => entry.contextWindow)) : 32768)
  const effort = config.reasoningEffort ?? 'auto'
  const explicit = effort !== 'auto' && effort !== 'off'
  const desired = ['high', 'xhigh', 'max'].includes(effort) ? 32768 : effort === 'medium' ? 16384 : 8192
  // 未知接口仅在用户明确请求推理档位时提高预留；普通默认保持现有保守预算。
  const ceiling = known.length ? Math.min(...known.map(entry => entry.maxTokens)) : explicit ? desired : 4096
  const output = Math.min(ceiling, desired, Math.floor(window / (explicit ? 3 : 4)))
  return { contextWindow: window, maxOutputTokens: output, compactionThreshold: config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
    source: config.contextWindow !== undefined ? 'custom' : known.length ? 'catalog' : 'default' }
}

/** 英文约每 3 字符一 Token，非 ASCII 每码点 2 Token；额外预留协议及估算余量。 */
export function estimateInputTokens(messages: unknown[], tools: unknown[] = []): number {
  let ascii = 0, other = 0
  for (const char of JSON.stringify({ messages, tools })) {
    if (char.codePointAt(0)! <= 0x7f) ascii++
    else other++
  }
  return Math.ceil(ascii / 3 + other * 2) + 128 + messages.length * 8 + tools.length * 16
}

/** 历史以完整问答为单位选取；旧工具正文不回放，严格材料模式只承接用户提问。 */
export function conversationHistory(messages: ChatMessage[], strict: boolean): string[] {
  const turns: string[] = []
  for (const message of messages) {
    if (message.role === 'user') turns.push('用户：' + message.text)
    else if (!strict && message.text && turns.length) turns[turns.length - 1] += '\n助手：' + message.text
  }
  return turns
}

interface RequestMessage { role?: string; content?: unknown; [key: string]: unknown }
interface ChatPayload { messages: RequestMessage[]; input?: never; tools?: unknown[]; [key: string]: unknown }
interface ResponsesPayload { input: RequestMessage[] | string; messages?: never; tools?: unknown[]; [key: string]: unknown }
export type ModelPayload = ChatPayload | ResponsesPayload
export interface BudgetedRequest<Payload extends ModelPayload = ModelPayload> { payload: Payload; budget: ContextBudget; error?: string }

export function fitModelRequest<Payload extends ModelPayload>(payload: Payload, history: readonly string[], limits: ModelLimits, model: string, summary = ''): BudgetedRequest<Payload> {
  const margin = safetyTokens(limits.contextWindow)
  const inputBudget = limits.contextWindow - limits.maxOutputTokens - margin
  const responses = payload.input !== undefined
  const original = responses ? typeof payload.input === 'string' ? [{ role: 'user', content: payload.input }] : payload.input : payload.messages
  const fixed = [payload.system, payload.instructions].filter(value => value !== undefined).map(content => ({ role: 'system', content }))
  const countTokens = (messages: RequestMessage[]) => estimateInputTokens([...fixed, ...messages], payload.tools)
  const userIndex = original.findIndex(message => message.role === 'user')
  const withHistory = (count: number): RequestMessage[] => {
    if (!history.length && !summary || userIndex < 0) return original
    const omitted = history.length - count
    const prefix = (summary ? '较早对话的摘要（只用于理解追问，文件事实仍须本轮读取）：\n' + summary + '\n\n' : '')
      + (omitted ? '（较早的 ' + omitted + ' 轮对话未纳入本次请求，完整历史仍保留。）\n' : '')
      + '之前的对话（仅用于理解追问，不能当作当前文件正文）：\n'
      + history.slice(history.length - count).join('\n\n') + '\n\n本轮请求：\n'
    return original.map((message, index) => index !== userIndex ? message : {
      ...message, content: typeof message.content === 'string' ? prefix + message.content
        : [{ type: responses ? 'input_text' : 'text', text: prefix }, ...(Array.isArray(message.content) ? message.content : [])],
    })
  }
  // 先保证本轮材料放得下，之后从近到远纳入完整历史，不截断问题或工具结果。
  let count = 0, messages = withHistory(0)
  let tokens = countTokens(messages)
  const blocked = tokens > inputBudget
  if (!blocked && userIndex >= 0) {
    let low = 0, high = history.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (countTokens(withHistory(mid)) <= inputBudget) low = mid
      else high = mid - 1
    }
    count = low; messages = withHistory(count); tokens = countTokens(messages)
  }
  const budget: ContextBudget = {
    model, contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens, safetyTokens: margin,
    inputBudget, inputTokens: tokens, percent: Math.round(tokens / limits.contextWindow * 100),
    source: limits.source, compactionThreshold: limits.compactionThreshold, historyTurns: history.length, omittedHistoryTurns: history.length - count, blocked,
  }
  const hasTools = original.some(message => message.role === 'tool' || message.type === 'function_call_output'
    || Array.isArray(message.content) && message.content.some(block => block?.type === 'tool_result'))
  const cause = hasTools ? '本轮工具返回或累计材料' : '本轮问题、技能说明与工具定义'
  return { payload: { ...payload, ...(responses ? { input: messages } : { messages }) }, budget,
    ...(blocked ? { error: cause + '超出模型输入预算（估算 ' + tokens + ' / ' + inputBudget
      + ' Token）。请缩短问题、减少显式技能或查询范围，按文件行范围分段读取；也可在模型高级设置核对上下文窗口。完整对话与工具记录已保留。' } : {}) }
}
