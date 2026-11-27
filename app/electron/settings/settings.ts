import path from 'node:path'
import type { ModelConfig } from '../env'
import { readJson, writeJson } from '../util/fs'
import type { Settings, SettingsInput } from '@shared/types'
import type { ModelCatalog, ModelCatalogInput, ModelChannel, ModelProfile } from '@shared/models'
import { resolveModelSettings } from '@shared/models'
import { JotError } from '@shared/result'
import { DEFAULT_MODEL_PROTOCOL } from '@shared/model-protocol'
import { modelCatalogInput } from './model-schema'

/** 密钥加解密。主进程里由 Electron 的 safeStorage 实现，测试里用假实现。 */
export interface SecretStore {
  encrypt(plain: string): string
  decrypt(encrypted: string): string
}
interface StoredChannel extends Omit<ModelChannel, 'hasApiKey'> { apiKeyEnc?: string }
interface StoredModels { channels: StoredChannel[]; defaultModelId: string | null }
interface SettingsFile {
  vaultPath?: string
  models: StoredModels
  classify: Settings['classify']
  capture: Settings['capture']
  window: Settings['window']
  daily: Settings['daily']
  maintenance: Settings['maintenance']
  appearance: Settings['appearance']
  layout: Settings['layout']
}
const DEFAULTS: SettingsFile = {
  models: { channels: [], defaultModelId: null },
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
  private listeners = new Set<(s: Settings, modelsChanged: boolean) => void>()
  private writes: Promise<void> = Promise.resolve()
  constructor(dir: string, private readonly secrets: SecretStore, private readonly devModel: ModelConfig | null = null) {
    this.file = path.join(dir, 'settings.json')
  }
  async load(): Promise<void> {
    const raw = await readJson<Partial<SettingsFile>>(this.file, {})
    this.data = {
      vaultPath: raw.vaultPath,
      models: raw.models ?? this.initialModels(),
      classify: { ...DEFAULTS.classify, ...raw.classify },
      capture: { ...DEFAULTS.capture, ...raw.capture },
      window: { closeBehavior: raw.window?.closeBehavior === 'quit' ? 'quit' : 'tray' },
      daily: { ...DEFAULTS.daily, ...raw.daily },
      maintenance: { ...DEFAULTS.maintenance, ...raw.maintenance },
      appearance: { ...DEFAULTS.appearance, ...raw.appearance },
      layout: { ...DEFAULTS.layout, ...raw.layout },
    }
  }
  private initialModels(): StoredModels {
    const config = this.devModel
    if (!config) return structuredClone(DEFAULTS.models)
    const profile: ModelProfile = { id: 'development-model', name: config.model, model: config.model, reasoningEffort: config.reasoningEffort ?? 'auto',
      ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}), ...(config.compactionThreshold ? { compactionThreshold: config.compactionThreshold } : {}) }
    return { channels: [{ id: 'development', name: '开发模型', protocol: config.protocol ?? DEFAULT_MODEL_PROTOCOL, baseUrl: config.baseUrl, apiKeyEnc: config.apiKey ? this.secrets.encrypt(config.apiKey) : undefined, models: [profile] }], defaultModelId: profile.id }
  }
  private catalog(): ModelCatalog {
    return { channels: this.data.models.channels.map(({ apiKeyEnc, ...channel }) => ({ ...structuredClone(channel), hasApiKey: !!apiKeyEnc })), defaultModelId: this.data.models.defaultModelId }
  }
  get(): Settings {
    return {
      models: this.catalog(),
      classify: { ...this.data.classify }, capture: { ...this.data.capture }, window: { ...this.data.window },
      daily: { ...this.data.daily }, maintenance: { ...this.data.maintenance },
      appearance: { ...this.data.appearance }, layout: { ...this.data.layout },
    }
  }
  get vaultPath(): string | undefined { return this.data.vaultPath }
  setVaultPath(vaultPath: string): Promise<void> {
    return this.enqueue(async () => {
      const updated = structuredClone(this.data)
      updated.vaultPath = vaultPath
      await this.save(updated)
      this.data = updated
    })
  }
  getModelConfig(modelId?: string | null): ModelConfig | null {
    const resolved = resolveModelSettings(this.catalog(), modelId === undefined ? this.catalog().defaultModelId : modelId)
    if (!resolved) {
      if (modelId) throw new JotError('LLM_NOT_CONFIGURED', '所选模型已删除或不存在，请重新选择模型')
      return null
    }
    const { hasApiKey: _hasKey, ...config } = resolved
    const channel = this.data.models.channels.find(channel => channel.id === resolved.channelId)!
    return { ...config, apiKey: channel.apiKeyEnc ? this.secrets.decrypt(channel.apiKeyEnc) : '' }
  }
  channelKey(channelId: string): string {
    const channel = this.data.models.channels.find(item => item.id === channelId)
    if (!channel) throw new JotError('NOT_FOUND', '渠道已删除，请重新选择')
    return channel.apiKeyEnc ? this.secrets.decrypt(channel.apiKeyEnc) : ''
  }
  set(input: SettingsInput): Promise<Settings> { return this.enqueue(() => this.apply(input)) }
  private async apply(input: SettingsInput): Promise<Settings> {
    const before = JSON.stringify(this.data.models), updated = structuredClone(this.data)
    if (input.models) updated.models = this.storeModels(input.models)
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
    for (const listener of this.listeners) listener(next, before !== JSON.stringify(updated.models))
    return next
  }
  private storeModels(input: ModelCatalogInput): StoredModels {
    const parsed = modelCatalogInput.safeParse(input)
    if (!parsed.success) throw new JotError('INVALID_INPUT', parsed.error.issues[0]?.message ?? '模型配置无效')
    return {
      defaultModelId: parsed.data.defaultModelId,
      channels: parsed.data.channels.map(({ apiKey, ...channel }) => {
        const previous = this.data.models.channels.find(item => item.id === channel.id)
        const apiKeyEnc = apiKey !== undefined ? apiKey ? this.secrets.encrypt(apiKey) : undefined
          : previous?.apiKeyEnc
        return { ...channel, apiKeyEnc }
      }),
    }
  }
  onChange(listener: (s: Settings, modelsChanged: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private async save(data = this.data): Promise<void> { await writeJson(this.file, data) }
  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writes.then(write)
    this.writes = result.then(() => {}, () => {})
    return result
  }
}
