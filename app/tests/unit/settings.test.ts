import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDevModelDefaults } from '../../electron/env'
import { SettingsService, type SecretStore } from '../../electron/settings/settings'
import { VaultService } from '../../electron/vault/vault'
import { makeTmpDir } from '../helpers/tmp'

// 假的加密实现：只做可逆变换，用来确认明文不会落盘
const secrets: SecretStore = {
  encrypt: (plain) => 'enc:' + Buffer.from(plain).toString('base64'),
  decrypt: (stored) => Buffer.from(stored.slice(4), 'base64').toString(),
}

let tmp: ReturnType<typeof makeTmpDir>
beforeEach(() => (tmp = makeTmpDir('settings')))
afterEach(() => tmp.cleanup())

describe('设置服务', () => {
  it('同时修改库路径、模型和窗口偏好不会丢失更新，失败不会阻断后续保存', async () => {
    const service = new SettingsService(tmp.dir, secrets)
    await service.load()
    await Promise.all([
      service.set({ model: { baseUrl: 'https://example.invalid/v1', model: 'fixture' } }),
      service.setVaultPath(path.join(tmp.dir, 'vault')),
      service.set({ appearance: { theme: 'dark' } }),
      service.set({ window: { closeBehavior: 'quit' } }),
    ])
    const [failed, saved] = await Promise.allSettled([
      service.set({ model: { compactionThreshold: 0.75 } as never }),
      service.set({ classify: { enabled: false } }),
    ])
    expect(failed.status).toBe('rejected'); expect(saved.status).toBe('fulfilled')
    const restarted = new SettingsService(tmp.dir, secrets)
    await restarted.load()
    expect(restarted.get()).toEqual(service.get())
    expect(restarted.vaultPath).toBe(path.join(tmp.dir, 'vault'))
    expect(restarted.get()).toMatchObject({ model: { model: 'fixture' }, appearance: { theme: 'dark' }, window: { closeBehavior: 'quit' }, classify: { enabled: false } })
  })

  it('磁盘保存失败不改变内存也不通知订阅者', async () => {
    const service = new SettingsService(tmp.dir, secrets)
    await service.load()
    const before = service.get()
    let changes = 0
    service.onChange(() => changes++)
    fs.mkdirSync(path.join(tmp.dir, 'settings.json'))
    await expect(service.set({ appearance: { theme: 'dark' } })).rejects.toThrow()
    expect(service.get()).toEqual(before)
    expect(changes).toBe(0)
    expect(fs.readdirSync(tmp.dir)).toEqual(['settings.json'])
  })

  it('密钥加密失败时当前设置、磁盘和订阅状态均保持原值', async () => {
    const working: SecretStore = { ...secrets }
    const service = new SettingsService(tmp.dir, working)
    await service.load()
    await service.set({ model: { baseUrl: 'https://example.invalid/v1', model: 'first', apiKey: 'fixture-before', contextWindow: 8192 } })
    const before = service.get()
    const raw = fs.readFileSync(path.join(tmp.dir, 'settings.json'), 'utf8')
    let changes = 0
    service.onChange(() => changes++)
    working.encrypt = () => { throw new Error('系统加密不可用') }
    await expect(service.set({ model: { model: 'second', apiKey: 'fixture-after', contextWindow: 16384 }, appearance: { theme: 'dark' } })).rejects.toThrow('系统加密不可用')
    expect(service.get()).toEqual(before)
    expect(fs.readFileSync(path.join(tmp.dir, 'settings.json'), 'utf8')).toBe(raw)
    expect(changes).toBe(0)
  })
  it('推理强度跨重启保存，单独改档不重建在途会话，切模型恢复默认', async () => {
    const s = new SettingsService(tmp.dir, secrets)
    await s.load()
    await s.set({ model: { baseUrl: 'https://example/v1', model: 'first' } })
    const changes: boolean[] = []
    s.onChange((_value, changed) => changes.push(changed))
    await s.set({ model: { reasoningEffort: 'high' } })
    expect(changes).toEqual([false])
    const restarted = new SettingsService(tmp.dir, secrets)
    await restarted.load()
    expect(restarted.get().model.reasoningEffort).toBe('high')
    const before = restarted.get()
    await expect(restarted.set({ model: { reasoningEffort: 'unknown' } as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(restarted.get()).toEqual(before)
    await restarted.set({ model: { model: 'second' } })
    expect(restarted.get().model.reasoningEffort).toBe('auto')
    await restarted.set({ model: { reasoningEffort: 'low' } })
    await restarted.set({ model: { baseUrl: 'https://another/v1' } })
    expect(restarted.get().model.reasoningEffort).toBe('auto')
  })
  it('窗口与压缩比例保存跨重启，null 恢复默认，切换模型只清除窗口覆盖', async () => {
    const s = new SettingsService(tmp.dir, secrets)
    await s.load()
    await s.set({ model: { baseUrl: 'http://example/v1', model: 'first', apiKey: 'fake', contextWindow: 16384, compactionThreshold: 0.8 } })
    const restarted = new SettingsService(tmp.dir, secrets)
    await restarted.load()
    expect(restarted.get().model).toMatchObject({ contextWindow: 16384, compactionThreshold: 0.8 })
    expect(restarted.getModelConfig()).toMatchObject({ contextWindow: 16384, compactionThreshold: 0.8 })
    expect(JSON.parse(fs.readFileSync(path.join(tmp.dir, 'settings.json'), 'utf8')).model).not.toHaveProperty('maxOutputTokens')
    await restarted.set({ model: { contextWindow: null, compactionThreshold: null } })
    expect(restarted.get().model).not.toHaveProperty('contextWindow')
    expect(restarted.getModelConfig()).not.toHaveProperty('compactionThreshold')
    expect(restarted.getModelConfig()).not.toHaveProperty('maxOutputTokens')
    await restarted.set({ model: { contextWindow: 8192, compactionThreshold: 0.6 } })
    await restarted.set({ model: { model: 'second' } })
    expect(restarted.get().model).not.toHaveProperty('contextWindow')
    expect(restarted.get().model.compactionThreshold).toBe(0.6)
    await restarted.set({ model: { contextWindow: 4096 } })
    await restarted.set({ model: { baseUrl: 'http://another/v1' } })
    expect(restarted.get().model).not.toHaveProperty('contextWindow')
  })

  it('无效预算不保存、不更改当前设置，预算变更会通知模型配置变化', async () => {
    const s = new SettingsService(tmp.dir, secrets)
    await s.load()
    await s.set({ model: { baseUrl: 'http://example/v1', model: 'first', contextWindow: 8192, compactionThreshold: 0.8 } })
    const changes: boolean[] = []
    s.onChange((_value, changed) => changes.push(changed))
    const before = s.get()
    await expect(s.set({ model: { compactionThreshold: 0.75 } as never })).rejects.toThrow('只能选择')
    await expect(s.set({ model: { contextWindow: 12.5 } })).rejects.toThrow('超出允许范围')
    expect(s.get()).toEqual(before)
    await s.set({ model: { contextWindow: 16384 } })
    await s.set({ model: { compactionThreshold: 0.6 } })
    await s.set({ appearance: { theme: 'dark' } })
    expect(changes).toEqual([true, true, false])
  })

  it('默认值符合确认清单', async () => {
    const s = new SettingsService(tmp.dir, secrets)
    await s.load()
    const v = s.get()
    expect(v).not.toHaveProperty('domains')
    expect(v.capture.hotkey).toBe('Ctrl+Alt+N')
    expect(v.window.closeBehavior).toBe('tray')
    expect(v.daily).toEqual({ enabled: true, time: '21:30' })
    expect(v.appearance.theme).toBe('system')
    expect(v.model).toEqual({ baseUrl: '', model: '', hasApiKey: false, reasoningEffort: 'auto' })
    expect(s.getModelConfig()).toBeNull()
  })

  it('关闭主窗口偏好跨重启保存', async () => {
    const s = new SettingsService(tmp.dir, secrets)
    await s.load()
    await s.set({ window: { closeBehavior: 'quit' } })
    const restarted = new SettingsService(tmp.dir, secrets)
    await restarted.load()
    expect(restarted.get().window.closeBehavior).toBe('quit')
  })

  it('密钥只能写入：界面拿不到原文，磁盘上也没有明文', async () => {
    const s = new SettingsService(tmp.dir, secrets)
    await s.load()
    const view = await s.set({ model: { baseUrl: 'http://x/v1', model: 'm', apiKey: 'sk-secret-123' } })
    expect(view.model).toEqual({ baseUrl: 'http://x/v1', model: 'm', hasApiKey: true, reasoningEffort: 'auto' })
    expect(JSON.stringify(view)).not.toContain('sk-secret-123')
    expect(fs.readFileSync(path.join(tmp.dir, 'settings.json'), 'utf8')).not.toContain('sk-secret-123')
    expect(s.getModelConfig()).toEqual({ baseUrl: 'http://x/v1', model: 'm', apiKey: 'sk-secret-123', reasoningEffort: 'auto' })
  })

  it('重新加载后设置仍在；只改地址时不丢密钥', async () => {
    const a = new SettingsService(tmp.dir, secrets)
    await a.load()
    await a.set({ model: { baseUrl: 'http://x/v1', model: 'm', apiKey: 'k1' }, appearance: { theme: 'light' } })
    await a.set({ model: { baseUrl: 'http://y/v1' } })

    const b = new SettingsService(tmp.dir, secrets)
    await b.load()
    expect(b.getModelConfig()).toEqual({ baseUrl: 'http://y/v1', model: 'm', apiKey: 'k1', reasoningEffort: 'auto' })
    expect(b.get().appearance.theme).toBe('light')
  })

  it('没填模型时使用开发期默认配置；填了以后以设置为准', async () => {
    const dev = { baseUrl: 'http://dev/v1', apiKey: 'devkey', model: 'dev-model' }
    const s = new SettingsService(tmp.dir, secrets, dev)
    await s.load()
    expect(s.getModelConfig()).toEqual({ ...dev, reasoningEffort: 'auto' })
    expect(s.get().model).toEqual({ baseUrl: 'http://dev/v1', model: 'dev-model', hasApiKey: true, reasoningEffort: 'auto' })
    await s.set({ model: { baseUrl: 'http://mine/v1', model: 'mine' } })
    expect(s.getModelConfig()).toEqual({ baseUrl: 'http://mine/v1', model: 'mine', apiKey: '', reasoningEffort: 'auto' })
  })

  it('文件夹通过实际目录管理，设置不再拥有独立领域列表', async () => {
    const vault = new VaultService()
    await vault.open(path.join(tmp.dir, 'vault'), true)
    const s = new SettingsService(tmp.dir, secrets)
    await s.load()
    await vault.createFolder('content', '家庭')
    expect((await vault.directories()).map(directory => directory.name)).toContain('家庭')
    expect(s.get()).not.toHaveProperty('domains')
    expect(JSON.parse(fs.readFileSync(path.join(tmp.dir, 'vault/.jot/config.json'), 'utf8'))).toEqual({ version: 3 })
    await vault.close()
  })

  it('变化时通知订阅者', async () => {
    const s = new SettingsService(tmp.dir, secrets)
    await s.load()
    const seen: string[] = []
    s.onChange((v) => seen.push(v.appearance.theme))
    await s.set({ appearance: { theme: 'dark' } })
    expect(seen).toEqual(['dark'])
  })
})

describe('开发期模型配置', () => {
  it('从 .env 读取，进程环境变量优先', () => {
    fs.writeFileSync(path.join(tmp.dir, '.env'), '# 注释\nJOT_LLM_BASE_URL="http://file/v1"\nJOT_LLM_API_KEY=filekey\nJOT_LLM_MODEL=file-model\n')
    expect(loadDevModelDefaults(tmp.dir, {})).toEqual({ baseUrl: 'http://file/v1', apiKey: 'filekey', model: 'file-model' })
    expect(loadDevModelDefaults(tmp.dir, { JOT_LLM_MODEL: 'env-model' })?.model).toBe('env-model')
  })

  it('没有配置时返回空；JOT_NO_DOTENV=1 时不读文件', () => {
    expect(loadDevModelDefaults(tmp.dir, {})).toBeNull()
    fs.writeFileSync(path.join(tmp.dir, '.env'), 'JOT_LLM_BASE_URL=http://file/v1\nJOT_LLM_MODEL=m\n')
    expect(loadDevModelDefaults(tmp.dir, { JOT_NO_DOTENV: '1' })).toBeNull()
  })
})
