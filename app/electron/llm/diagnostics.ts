import type { ModelState, ModelTestResult } from '@shared/types'
import type { ModelConfig } from '../env'
import type { PiHost } from '../agent/pi'
import { reasoningFailure } from '../agent/reasoning'
import { DEFAULT_MODEL_PROTOCOL } from '@shared/model-protocol'

/** 仅负责连接测试及可用状态；业务推理全部经AiExecutor/PiHost。 */
export class ModelDiagnostics {
  private state: ModelState
  private listeners = new Set<(state: ModelState, message?: string) => void>()
  constructor(private readonly getConfig: () => ModelConfig | null) { this.state = getConfig() ? 'ok' : 'not-configured' }
  status(): ModelState {
    if (!this.getConfig()) return 'not-configured'
    return this.state === 'not-configured' ? 'ok' : this.state
  }
  onStatus(listener: (state: ModelState, message?: string) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener)
  }
  refresh(): void { this.setState(this.getConfig() ? 'ok' : 'not-configured') }
  private setState(state: ModelState, message?: string): void {
    if (state === this.state) return
    this.state = state
    for (const listener of this.listeners) listener(state, message)
  }
  report(config: ModelConfig, state: ModelState, message?: string): void {
    const current = this.getConfig()
    if (current?.id === config.id && current?.baseUrl === config.baseUrl && current.model === config.model && current.apiKey === config.apiKey
      && (current.protocol ?? DEFAULT_MODEL_PROTOCOL) === (config.protocol ?? DEFAULT_MODEL_PROTOCOL)) this.setState(state, message)
  }
  async test(pi: PiHost, cwd: string, override: Partial<ModelConfig> = {}, base: ModelConfig | null = this.getConfig()): Promise<ModelTestResult> {
    const config: ModelConfig = { ...base, ...override, baseUrl: override.baseUrl || base?.baseUrl || '',
      model: override.model || base?.model || '', apiKey: override.apiKey ?? base?.apiKey ?? '' }
    if (!config.baseUrl || !config.model) return { ok: false, message: '请先填写接口地址和模型名' }
    const started = Date.now()
    let session: Awaited<ReturnType<PiHost['createSession']>> | undefined
    try {
      session = await pi.createSession({ cwd, modelConfig: config, systemPrompt: '连接测试。只回复“好”。', tools: [] })
      const timeout = setTimeout(() => { void session?.abort().catch(() => {}) }, 30_000); timeout.unref()
      try { await session.prompt('回复“好”', { expandPromptTemplates: false }) } finally { clearTimeout(timeout) }
      const last = session.messages.findLast(message => message.role === 'assistant')
      if (last?.role !== 'assistant' || last.stopReason !== 'stop' || !session.getLastAssistantText()?.trim()) {
        throw reasoningFailure(last?.role === 'assistant' ? last.errorMessage || '连接测试未得到完整回答，请核对模型或推理档位。' : '未得到模型回答', config.reasoningEffort)
      }
      this.report(config, 'ok')
      return { ok: true, latencyMs: Date.now() - started }
    } catch (error) {
      const message = (error as Error).message
      this.report(config, 'unavailable', message)
      return { ok: false, message }
    } finally { session?.dispose() }
  }
}
