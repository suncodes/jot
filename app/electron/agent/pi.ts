// Pi宿主统一模型资料、推理选择和最终发送预算；会话只在内存，关闭内置文件／命令工具。
import fs from 'node:fs'
import path from 'node:path'
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { JotError } from '@shared/result'
import type { ModelState } from '@shared/types'
import type { ReasoningEffort, ResolvedReasoning } from '@shared/reasoning'
import type { ModelConfig } from '../env'
import type { ContextBudget, ModelBudgetOverrides } from '@shared/model-budget'
import { fitModelRequest, resolveModelLimits, type ModelPayload, type ModelLimits, type BudgetedRequest } from './budget'
import { cleanReasoningPayload, resolveReasoning, sentReasoning, trustedModel } from './reasoning'
import { DEFAULT_MODEL_PROTOCOL, MODEL_PROTOCOLS, protocolBaseUrl, type ModelEndpoint } from '@shared/model-protocol'

type Pi = typeof import('@earendil-works/pi-coding-agent')
const PROVIDER = 'jot'
let piModule: Promise<Pi> | null = null
export function loadPi(): Promise<Pi> { piModule ??= import('@earendil-works/pi-coding-agent'); return piModule }

export interface PiSessionOptions {
  cwd: string
  systemPrompt: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ToolDefinition<any, any, any>[]
  /** 省略继承全局；auto明确使用服务端默认。 */
  reasoningEffort?: ReasoningEffort
  internalReasoning?: boolean
  /** 同一业务运行（含格式修正）固定模型配置。 */
  modelConfig?: ModelConfig
  onReasoning?: (reasoning: ResolvedReasoning) => void
  history?: string[]
  onBudget?: (budget: ContextBudget) => void
  prepareRequest?: (payload: ModelPayload, limits: ModelLimits, model: string) => Promise<BudgetedRequest>
}
export class PiHost {
  constructor(private readonly agentDir: string, private readonly getModelConfig: (modelId?: string) => ModelConfig | null, private readonly report?: (config: ModelConfig, state: ModelState, message?: string) => void) {}
  configuration(modelId?: string): ModelConfig {
    const config = this.getModelConfig(modelId)
    if (!config) throw new JotError('LLM_NOT_CONFIGURED', '还没有配置模型')
    return { ...config }
  }
  private async runtime() {
    const pi = await loadPi()
    return pi.ModelRuntime.create({ authPath: path.join(this.agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  }
  async resolveLimits(config: ModelBudgetOverrides & ModelEndpoint & { reasoningEffort?: ReasoningEffort }): Promise<ModelLimits> {
    const runtime = await this.runtime()
    return resolveModelLimits(config, runtime.getModels())
  }
  async reasoningOptions(config: ModelEndpoint & Pick<ModelConfig, 'reasoningEffort'>): Promise<ResolvedReasoning> {
    return resolveReasoning({ ...config, reasoningEffort: 'auto' }, (await this.runtime()).getModels())
  }
  async createSession(opts: PiSessionOptions): Promise<AgentSession> {
    const cfg = opts.modelConfig ?? this.configuration()
    const protocol = cfg.protocol ?? DEFAULT_MODEL_PROTOCOL
    if (!MODEL_PROTOCOLS.includes(protocol)) throw new JotError('INVALID_INPUT', '模型接口协议不受支持')
    const pi = await loadPi()
    await fs.promises.mkdir(this.agentDir, { recursive: true })
    const modelRuntime = await this.runtime(), models = modelRuntime.getModels()
    const reasoning = resolveReasoning(cfg, models, opts.reasoningEffort, opts.internalReasoning)
    opts.onReasoning?.(reasoning)
    const known = trustedModel(cfg, models)
    const limits = resolveModelLimits({ ...cfg, reasoningEffort: reasoning.requested }, models)
    modelRuntime.registerProvider(PROVIDER, {
      baseUrl: protocolBaseUrl(cfg), api: protocol, apiKey: 'set-at-runtime',
      models: [{ id: cfg.model, name: cfg.model, contextWindow: limits.contextWindow, maxTokens: limits.maxOutputTokens,
        reasoning: known?.reasoning ?? true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(known?.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
        ...(known?.api === protocol && known.compat ? { compat: known.compat }
          : protocol === 'openai-completions' ? { compat: { thinkingFormat: 'openai' as const, supportsReasoningEffort: true } } : {}),
      }],
    })
    await modelRuntime.setRuntimeApiKey(PROVIDER, cfg.apiKey || 'none')
    const model = modelRuntime.getModel(PROVIDER, cfg.model)
    if (!model) throw new JotError('LLM_NOT_CONFIGURED', 'Pi找不到模型：' + cfg.model)
    const settingsManager = pi.SettingsManager.inMemory({ enableInstallTelemetry: false, compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } })
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: opts.cwd, agentDir: this.agentDir, settingsManager,
      noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, noSkills: true,
      systemPrompt: opts.systemPrompt, appendSystemPrompt: [],
    })
    await resourceLoader.reload()
    const { session } = await pi.createAgentSession({
      cwd: opts.cwd, agentDir: this.agentDir, modelRuntime, model,
      ...(reasoning.requested !== 'auto' ? { thinkingLevel: reasoning.requested } : {}),
      resourceLoader, settingsManager, sessionManager: pi.SessionManager.inMemory(opts.cwd),
      noTools: 'builtin', customTools: opts.tools,
    })
    session.subscribe(event => {
      if (event.type !== 'message_end' || event.message.role !== 'assistant') return
      if (event.message.stopReason === 'stop' || event.message.stopReason === 'toolUse') this.report?.(cfg, 'ok')
      else if (event.message.stopReason === 'error' && !/模型输入预算|未生成所选推理强度/.test(event.message.errorMessage ?? '')) this.report?.(cfg, 'unavailable', event.message.errorMessage)
    })
    const stream = session.agent.streamFunction
    session.agent.streamFunction = (model, context, options) => stream(model, context, { ...options, maxRetries: 0, timeoutMs: 90_000 })
    let sent = reasoning
    session.agent.onProviderStreamEvent = data => {
      if (!data || typeof data !== 'object') return
      const event = data as { reasoning_effort?: unknown; reasoning?: { effort?: unknown } }
      const reported = event.reasoning_effort ?? event.reasoning?.effort
      if (typeof reported === 'string') { sent = { ...sent, reported }; opts.onReasoning?.(sent) }
    }
    const previousPayload = session.agent.onPayload
    session.agent.onPayload = async (payload, requestModel) => {
      const original = await previousPayload?.(payload, requestModel) ?? payload
      const adapted = reasoning.requested === 'auto' ? cleanReasoningPayload(original as Record<string, unknown>) : original
      const request = opts.prepareRequest
        ? await opts.prepareRequest(adapted as ModelPayload, limits, cfg.model)
        : fitModelRequest(adapted as ModelPayload, opts.history ?? [], limits, cfg.model)
      opts.onBudget?.(request.budget)
      if (request.error) throw new JotError('LLM_CONTEXT_LIMIT', request.error)
      const outputField = protocol === 'openai-responses' ? 'max_output_tokens'
        : protocol === 'anthropic-messages' || 'max_tokens' in request.payload ? 'max_tokens' : 'max_completion_tokens'
      const final = { ...request.payload, [outputField]: limits.maxOutputTokens }
      sent = sentReasoning(reasoning, final)
      if (reasoning.requested !== 'auto' && !sent.parameters) throw new JotError('INVALID_INPUT', '当前模型适配未生成所选推理强度参数，请改用模型默认或支持的档位。')
      opts.onReasoning?.(sent)
      return final
    }
    return session
  }
}
