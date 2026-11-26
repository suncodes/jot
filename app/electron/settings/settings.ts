import path from 'node:path'
import type { ModelConfig } from '../env'
import { readJson, writeJson } from '../util/fs'
import type { Settings, SettingsInput } from '@shared/types'
import { COMPACTION_THRESHOLDS, MODEL_BUDGET_BOUNDS, type ModelBudgetOverrides } from '@shared/model-budget'
import { JotError } from '@shared/result'
import { REASONING_EFFORTS, type ReasoningEffort } from '@shared/reasoning'
import { DEFAULT_MODEL_PROTOCOL, MODEL_PROTOCOLS, type ModelProtocol } from '@shared/model-protocol'

/** 密钥加解密。主进程里由 Electron 的 safeStorage 实现，测试里用假实现。 */
export interface SecretStore {
  encrypt(plain: string): string
  decrypt(encrypted: string): string
}

interface SettingsFile {
  vaultPath?: string
  model: { protocol: ModelProtocol; baseUrl: string; model: string; apiKeyEnc?: string; reasoningEffort?: ReasoningEffort } & ModelBudgetOverrides
  classify: Settings['classify']
  capture: Settings['capture']
  window: Settings['window']
  daily: Settings['daily']
  maintenance: Settings['maintenance']
  appearance: Settings['appearance']
  layout: Settings['layout']
}

const DEFAULTS: SettingsFile = {
  model: { protocol: DEFAULT_MODEL_PROTOCOL, baseUrl: '', model: '', reasoningEffort: 'auto' },
  classify: { enabled: true },
  capture: { hotkey: 'Ctrl+Alt+N', launchAtLogin: false },
  window: { closeBehavior: 'tray' },
  daily: { enabled: true, time: '21:30' },
  maintenance: { trashRetentionDays: 0 },
  appearance: { theme: 'system' },
  layout: { sideWidth: 224, agentWidth: 420, sideCollapsed: false, agentCollapsed: true },
}

export class SettingsService {
  private data: SettingsFile = structuredClone(DEFAULTS)
  private readonly file: string
  private listeners = new Set<(s: Settings, modelChanged: boolean) => void>()
  private writes: Promise<void> = Promise.resolve()

  constructor(
    dir: string,
    private readonly secrets: SecretStore,
    /** 开发期默认的模型配置；设置里没填模型时使用 */
    private readonly devModel: ModelConfig | null = null,
  ) {
    this.file = path.join(dir, 'settings.json')
  }

  async load(): Promise<void> {
    const raw = await readJson<Partial<SettingsFile>>(this.file, {})
    this.data = {
      vaultPath: raw.vaultPath,
      model: { protocol: raw.model?.protocol ?? DEFAULT_MODEL_PROTOCOL, baseUrl: raw.model?.baseUrl ?? '', model: raw.model?.model ?? '', apiKeyEnc: raw.model?.apiKeyEnc, reasoningEffort: raw.model?.reasoningEffort && REASONING_EFFORTS.includes(raw.model.reasoningEffort) ? raw.model.reasoningEffort : 'auto',
        ...(raw.model?.contextWindow !== undefined ? { contextWindow: raw.model.contextWindow } : {}),
        ...(raw.model?.compactionThreshold !== undefined ? { compactionThreshold: raw.model.compactionThreshold } : {}) },
      classify: { enabled: raw.classify?.enabled ?? DEFAULTS.classify.enabled },
      capture: { ...DEFAULTS.capture, ...raw.capture },
      window: { ...DEFAULTS.window, ...raw.window },
      daily: { ...DEFAULTS.daily, ...raw.daily },
      maintenance: { trashRetentionDays: raw.maintenance?.trashRetentionDays === 30 ? 30 : 0 },
      appearance: { ...DEFAULTS.appearance, ...raw.appearance },
      layout: { ...DEFAULTS.layout, ...raw.layout },
    }
  }

  get vaultPath(): string | undefined {
    return this.data.vaultPath
  }

  setVaultPath(p: string): Promise<void> {
    return this.enqueue(async () => {
      const updated = { ...this.data, vaultPath: p }
      await this.save(updated)
      this.data = updated
    })
  }

  /** 给界面看的设置：不含密钥原文 */
  get(): Settings {
    const model = this.getModelConfig()
    return {
      model: { protocol: model?.protocol ?? this.data.model.protocol, baseUrl: model?.baseUrl ?? '', model: model?.model ?? '', hasApiKey: !!model?.apiKey, reasoningEffort: model?.reasoningEffort ?? 'auto', ...this.budgetOverrides() },
      classify: { ...this.data.classify },
      capture: { ...this.data.capture },
      window: { ...this.data.window },
      daily: { ...this.data.daily },
      maintenance: { ...this.data.maintenance },
      appearance: { ...this.data.appearance },
      layout: { ...this.data.layout },
    }
  }

  private budgetOverrides(): ModelBudgetOverrides {
    const { contextWindow, compactionThreshold } = this.data.model
    return { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(compactionThreshold !== undefined ? { compactionThreshold } : {}) }
  }

  /** 给模型客户端和 Agent 用的完整配置；没配置时返回 null */
  getModelConfig(): ModelConfig | null {
    const { baseUrl, model, apiKeyEnc } = this.data.model
    if (baseUrl && model) {
      let apiKey = ''
      if (apiKeyEnc) {
        try {
          apiKey = this.secrets.decrypt(apiKeyEnc)
        } catch {
          apiKey = ''
        }
      }
      return { baseUrl, model, apiKey, protocol: this.data.model.protocol, reasoningEffort: this.data.model.reasoningEffort ?? 'auto', ...this.budgetOverrides() }
    }
    return this.devModel ? { ...this.devModel, protocol: this.devModel.protocol ?? DEFAULT_MODEL_PROTOCOL, reasoningEffort: this.data.model.reasoningEffort ?? 'auto', ...this.budgetOverrides() } : null
  }

  set(input: SettingsInput): Promise<Settings> {
    return this.enqueue(() => this.apply(input))
  }

  private async apply(input: SettingsInput): Promise<Settings> {
    const previousModel = this.getModelConfig()
    const updated = structuredClone(this.data)
    if (input.model) {
      const { baseUrl, model, apiKey, protocol } = input.model
      if (protocol !== undefined && !MODEL_PROTOCOLS.includes(protocol)) throw new JotError('INVALID_INPUT', '模型接口协议不受支持')
      const changedIdentity = baseUrl !== undefined && baseUrl.trim() !== previousModel?.baseUrl
        || model !== undefined && model.trim() !== previousModel?.model
        || protocol !== undefined && protocol !== (previousModel?.protocol ?? this.data.model.protocol)
      const overrides = this.budgetOverrides()
      if (changedIdentity) delete overrides.contextWindow
      const { contextWindow, compactionThreshold, reasoningEffort } = input.model
      if (contextWindow === null) delete overrides.contextWindow
      else if (contextWindow !== undefined) {
        const bounds = MODEL_BUDGET_BOUNDS.contextWindow
        if (!Number.isInteger(contextWindow) || contextWindow < bounds.min || contextWindow > bounds.max) throw new JotError('INVALID_INPUT', '模型 Token 配置超出允许范围')
        overrides.contextWindow = contextWindow
      }
      if (reasoningEffort !== undefined && !REASONING_EFFORTS.includes(reasoningEffort)) { throw new JotError('INVALID_INPUT', '推理强度不受支持') }
      if (compactionThreshold === null) delete overrides.compactionThreshold
      else if (compactionThreshold !== undefined) {
        if (!COMPACTION_THRESHOLDS.includes(compactionThreshold)) throw new JotError('INVALID_INPUT', '压缩触发比例只能选择 60%、70% 或 80%')
        overrides.compactionThreshold = compactionThreshold
      }
      updated.model.contextWindow = overrides.contextWindow
      updated.model.compactionThreshold = overrides.compactionThreshold
      updated.model.reasoningEffort = changedIdentity ? reasoningEffort ?? 'auto' : reasoningEffort ?? updated.model.reasoningEffort ?? 'auto'
      if (baseUrl !== undefined) updated.model.baseUrl = baseUrl.trim()
      if (model !== undefined) updated.model.model = model.trim()
      if (protocol !== undefined) updated.model.protocol = protocol
      if (apiKey !== undefined) updated.model.apiKeyEnc = apiKey ? this.secrets.encrypt(apiKey) : undefined
    }
    if (input.classify) Object.assign(updated.classify, input.classify)
    if (input.capture) Object.assign(updated.capture, input.capture)
    if (input.window) Object.assign(updated.window, input.window)
    if (input.daily) Object.assign(updated.daily, input.daily)
    if (input.maintenance) Object.assign(updated.maintenance, input.maintenance)
    if (input.appearance) Object.assign(updated.appearance, input.appearance)
    if (input.layout) Object.assign(updated.layout, input.layout)
    await this.save(updated)
    this.data = updated
    const next = this.get()
    const model = this.getModelConfig()
    const modelChanged = model?.protocol !== previousModel?.protocol || model?.baseUrl !== previousModel?.baseUrl || model?.model !== previousModel?.model || model?.apiKey !== previousModel?.apiKey
      || model?.contextWindow !== previousModel?.contextWindow || model?.compactionThreshold !== previousModel?.compactionThreshold
    for (const l of this.listeners) l(next, modelChanged)
    return next
  }

  onChange(listener: (s: Settings, modelChanged: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async save(data = this.data): Promise<void> {
    await writeJson(this.file, data)
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writes.then(write)
    this.writes = result.then(() => {}, () => {})
    return result
  }
}
