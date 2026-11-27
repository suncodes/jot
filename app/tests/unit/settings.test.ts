import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsService, type SecretStore } from '../../electron/settings/settings'
import { loadDevModelDefaults } from '../../electron/env'
import { modelSettings } from '../helpers/models'
import { makeTmpDir } from '../helpers/tmp'
const secrets: SecretStore = { encrypt: plain => 'enc:' + Buffer.from(plain).toString('base64'), decrypt: stored => Buffer.from(stored.slice(4), 'base64').toString() }
let tmp: ReturnType<typeof makeTmpDir>
beforeEach(() => { tmp = makeTmpDir('settings') })
afterEach(() => tmp.cleanup())
describe('多渠道模型设置', () => {
  it('空配置不猜测全局默认，普通偏好独立保存', async () => {
    const service = new SettingsService(tmp.dir, secrets)
    await service.load()
    expect(service.get().models).toEqual({ channels: [], defaultModelId: null })
    expect(service.getModelConfig()).toBeNull()
    await service.set({ window: { closeBehavior: 'quit' }, appearance: { theme: 'dark' } })
    const restored = new SettingsService(tmp.dir, secrets); await restored.load()
    expect(restored.get()).toMatchObject({ window: { closeBehavior: 'quit' }, appearance: { theme: 'dark' } })
  })
  it('多渠道和同名模型独立解析，密钥加密且不传给界面', async () => {
    const service = new SettingsService(tmp.dir, secrets); await service.load()
    const input = modelSettings({ baseUrl: 'https://one.invalid/v1', model: 'same-name', apiKey: 'fixture-key-one' })
    const second = structuredClone(input.models.channels[0]!)
    second.id = 'second'; second.name = '第二渠道'; second.protocol = 'anthropic-messages'; second.apiKey = 'fixture-key-two'
    second.models[0]!.id = 'second-model'; second.models[0]!.contextWindow = 65536
    input.models.channels.push(second)
    const view = await service.set(input)
    expect(service.getModelConfig()?.apiKey).toBe('fixture-key-one')
    expect(service.getModelConfig('second-model')).toMatchObject({ protocol: 'anthropic-messages', model: 'same-name', apiKey: 'fixture-key-two', contextWindow: 65536 })
    const disk = fs.readFileSync(path.join(tmp.dir, 'settings.json'), 'utf8')
    expect(disk).not.toContain('fixture-key-one'); expect(disk).not.toContain('fixture-key-two')
    expect(JSON.stringify(view)).not.toContain('fixture-key')
    const restored = new SettingsService(tmp.dir, secrets); await restored.load()
    expect(restored.get()).toEqual(view)
    expect(restored.getModelConfig('second-model')?.apiKey).toBe('fixture-key-two')
  })
  it('省略密钥保留该渠道密钥，明确空值清除，新增渠道不复用其他密钥', async () => {
    const service = new SettingsService(tmp.dir, secrets); await service.load()
    await service.set(modelSettings({ apiKey: 'fixture-key' }))
    const input = modelSettings({ model: 'second' }, service.get())
    await service.set(input)
    expect(service.getModelConfig()?.apiKey).toBe('fixture-key')
    input.models.channels[0]!.apiKey = ''
    await service.set(input)
    expect(service.getModelConfig()?.apiKey).toBe('')
    const other = structuredClone(input.models.channels[0]!)
    other.id = 'other'; other.models[0]!.id = 'other-model'; delete other.apiKey
    input.models.channels.push(other)
    await service.set(input)
    expect(service.getModelConfig('other-model')?.apiKey).toBe('')
  })
  it('默认引用、模型ID唯一性、协议和窗口均在保存前校验', async () => {
    const service = new SettingsService(tmp.dir, secrets); await service.load()
    const valid = modelSettings({})
    await service.set(valid)
    const before = service.get()
    for (const change of [
      () => { const input = structuredClone(valid); input.models.defaultModelId = 'missing'; return input },
      () => { const input = structuredClone(valid); input.models.channels[0]!.models.push(input.models.channels[0]!.models[0]!); return input },
      () => { const input = structuredClone(valid); input.models.channels[0]!.protocol = 'unknown' as never; return input },
      () => { const input = structuredClone(valid); input.models.channels[0]!.models[0]!.contextWindow = 10; return input },
      () => { const input = structuredClone(valid); input.models.channels[0]!.baseUrl = 'http://'; return input },
    ]) {
      await expect(service.set(change())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(service.get()).toEqual(before)
    }
    expect(() => service.getModelConfig('deleted')).toThrow('重新选择')
  })
  it('加密失败或落盘失败不改变内存及订阅，后续仍可保存', async () => {
    const working = { ...secrets }, service = new SettingsService(tmp.dir, working); await service.load()
    await service.set(modelSettings({ apiKey: 'before' }))
    const before = service.get(), disk = fs.readFileSync(path.join(tmp.dir, 'settings.json'), 'utf8')
    let changes = 0; service.onChange(() => changes++)
    working.encrypt = () => { throw new Error('系统加密不可用') }
    await expect(service.set(modelSettings({ apiKey: 'after' }, before))).rejects.toThrow('加密不可用')
    expect(service.get()).toEqual(before); expect(fs.readFileSync(path.join(tmp.dir, 'settings.json'), 'utf8')).toBe(disk); expect(changes).toBe(0)
    await service.set({ classify: { enabled: false } })
    expect(changes).toBe(1)
    const blocked = path.join(tmp.dir, 'blocked'); fs.mkdirSync(path.join(blocked, 'settings.json'), { recursive: true })
    const failing = new SettingsService(blocked, secrets)
    await expect(failing.set({ appearance: { theme: 'dark' } })).rejects.toThrow()
    expect(failing.get().appearance.theme).toBe('system')
  })
  it('并发保存库路径和配置不丢更新，开发模型转为同一渠道结构', async () => {
    const dev = { baseUrl: 'https://dev.invalid/v1', model: 'development', apiKey: 'dev-key' }
    const service = new SettingsService(tmp.dir, secrets, dev); await service.load()
    expect(service.getModelConfig()).toMatchObject({ ...dev, id: 'development-model', channelId: 'development' })
    await Promise.all([service.setVaultPath(path.join(tmp.dir, 'vault')), service.set(modelSettings({ model: 'configured' }, service.get())), service.set({ capture: { hotkey: 'Ctrl+Alt+J' } })])
    const restored = new SettingsService(tmp.dir, secrets); await restored.load()
    expect(restored.vaultPath).toBe(path.join(tmp.dir, 'vault'))
    expect(restored.get().capture.hotkey).toBe('Ctrl+Alt+J')
    expect(restored.getModelConfig()).toMatchObject({ model: 'configured', apiKey: 'dev-key' })
  })
})
describe('开发环境模型入口', () => {
  it('支持协议及环境变量优先级，未知协议明确报错', () => {
    const env = { JOT_NO_DOTENV: '1', JOT_LLM_BASE_URL: 'https://fixture.invalid/v1', JOT_LLM_MODEL: 'fixture', JOT_LLM_PROTOCOL: 'anthropic-messages' }
    expect(loadDevModelDefaults(tmp.dir, env)?.protocol).toBe('anthropic-messages')
    expect(() => loadDevModelDefaults(tmp.dir, { ...env, JOT_LLM_PROTOCOL: 'other' })).toThrow('协议不受支持')
    fs.writeFileSync(path.join(tmp.dir, '.env'), ['JOT_LLM_BASE_URL=https://fixture.invalid/v1', 'JOT_LLM_MODEL=file-model'].join(String.fromCharCode(10)), 'utf8')
    expect(loadDevModelDefaults(tmp.dir, {})?.model).toBe('file-model')
    expect(loadDevModelDefaults(tmp.dir, { JOT_LLM_MODEL: 'env-model' })?.model).toBe('env-model')
    expect(loadDevModelDefaults(tmp.dir, { JOT_NO_DOTENV: '1' })).toBeNull()
  })
})
