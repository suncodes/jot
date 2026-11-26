import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppExtensionConfiguration, createShortcutConfiguration, type AppExtensionManifest } from '@shared/app-extensions'
import { appExtensionConfiguration, appExtensionManifest, shortcutConfiguration } from '../../electron/extensions/schema'
import { testApp } from '../helpers/test-app'

const manifest = (): AppExtensionManifest => ({
  schemaVersion: 1, apiVersion: 1, id: 'work-diary', name: '工作日记', version: '1.0.0', minAppVersion: '0.1.0', description: '创建或打开今天的工作日记',
  commands: [{ id: 'today', name: '写今日工作日记', icon: 'briefcase-business', action: 'daily-note', defaults: {
    directory: null, filename: '{{yyyy}}-{{MM}}-{{dd}} 工作日记.md', template: { kind: 'package', path: 'templates/default.md' },
  } }],
})

describe('应用扩展契约', () => {
  it('独立清单只声明固定动作，目录可待配置', () => {
    expect(appExtensionManifest.parse(manifest())).toEqual(manifest())
    const configured = manifest()
    configured.commands[0]!.defaults = { directory: 'content/工作/{{yyyy}}年-{{MM}}月/{{dd}}日', filename: '工作日记.md', template: { kind: 'user', path: 'templates/工作日记.md' } }
    expect(appExtensionManifest.parse(configured)).toEqual(configured)
  })

  it('拒绝 AI 清单、任意代码入口、旧原型字段与未知版本', () => {
    for (const invalid of [
      { ...manifest(), agents: [] }, { ...manifest(), main: 'index.js' }, { ...manifest(), schemaVersion: 2 },
      { ...manifest(), apiVersion: 2 }, { ...manifest(), id: 'core' }, { ...manifest(), version: 'latest' },
      { id: 'ai', name: '能力包', skills: [] },
    ]) expect(appExtensionManifest.safeParse(invalid).success).toBe(false)
    for (const changed of [{ action: 'ipc' }, { icon: '<svg />' }, { folders: 'year-month' }]) {
      const invalid = manifest()
      Object.assign(invalid.commands[0]!, changed)
      expect(appExtensionManifest.safeParse(invalid).success).toBe(false)
    }
  })

  it('命令和配置标识不能重复，默认模板不能越界', () => {
    const invalid = manifest()
    invalid.commands.push(invalid.commands[0]!)
    expect(appExtensionManifest.safeParse(invalid).success).toBe(false)
    invalid.commands.pop()
    invalid.commands[0]!.defaults.template = { kind: 'package', path: '../default.md' }
    expect(appExtensionManifest.safeParse(invalid).success).toBe(false)
    const profile = { id: 'daily', commandId: 'today', name: '日记', options: manifest().commands[0]!.defaults }
    expect(appExtensionConfiguration.safeParse({ schemaVersion: 1, extensions: { 'work-diary': { enabled: true, profiles: [profile, profile] } } }).success).toBe(false)
    expect(appExtensionConfiguration.safeParse({ schemaVersion: 1, installed: [], extensions: {} }).success).toBe(false)
  })

  it('固定项保持顺序，快捷键规范化并检查重复和应用保留键', () => {
    const config = { schemaVersion: 1, pinned: ['core.theme', 'core.new-note'], bindings: [{ commandId: 'core.theme', hotkey: 'Shift+Ctrl+d' }] }
    expect(shortcutConfiguration.parse(config).bindings[0]!.hotkey).toBe('Ctrl+Shift+D')
    for (const hotkey of ['Ctrl+N', 'Ctrl+Shift+P', 'Ctrl+V', 'Meta+S', 'Alt+F4', 'Shift+D', 'D', 'Ctrl+Ctrl+D']) {
      expect(shortcutConfiguration.safeParse({ ...config, bindings: [{ commandId: 'core.theme', hotkey }] }).success).toBe(false)
    }
    expect(shortcutConfiguration.safeParse({ ...config, pinned: ['core.theme', 'core.theme'] }).success).toBe(false)
    expect(shortcutConfiguration.safeParse({ ...config, bindings: [{ commandId: 'core.theme', hotkey: 'Ctrl+Shift+D' }, { commandId: 'core.new-note', hotkey: 'Shift+Ctrl+d' }] }).success).toBe(false)
    expect(shortcutConfiguration.safeParse({ ...config, pinned: ['settings:set'] }).success).toBe(false)
  })
})

describe('应用扩展 JSON 存储与模板边界', () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined
  afterEach(async () => { await app?.close(); app = undefined })

  it('无配置时返回空结构，不擅自安装、启用或固定', async () => {
    app = await testApp()
    expect(await app.call('extensions:configuration', undefined)).toEqual(createAppExtensionConfiguration())
    expect(await app.call('shortcuts:get', undefined)).toEqual(createShortcutConfiguration())
    expect(fs.existsSync(app.file('.jot/app-extensions.json'))).toBe(false)
    expect(fs.existsSync(app.file('.jot/shortcuts.json'))).toBe(false)
    expect(fs.readdirSync(app.file('.jot/app-extensions'))).toEqual([])
    expect(fs.statSync(app.file('templates')).isDirectory()).toBe(true)
  })

  it('两个独立配置及快捷操作经重启、删除索引、重建保留，不改 AI 配置', async () => {
    app = await testApp()
    const config = createAppExtensionConfiguration()
    for (const id of ['personal-diary', 'work-diary']) config.extensions[id] = { enabled: id === 'personal-diary', profiles: [{ id: 'daily', commandId: 'today', name: id, options: manifest().commands[0]!.defaults }] }
    const assistant = fs.existsSync(app.file('.jot/assistant.json')) ? fs.readFileSync(app.file('.jot/assistant.json'), 'utf8') : null
    const usage = await app.call('maintenance:usage', undefined)
    await app.core.mutate(() => app!.core.extensionState.saveConfiguration(config))
    const shortcuts = await app.call('shortcuts:set', { schemaVersion: 1, pinned: ['core.theme', 'core.new-note'], bindings: [{ commandId: 'core.theme', hotkey: 'Ctrl+Shift+D' }] })
    expect(JSON.parse(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8'))).toEqual(config)
    expect((await app.call('maintenance:usage', undefined)).configurationBytes - usage.configurationBytes).toBe(fs.statSync(app.file('.jot/app-extensions.json')).size + fs.statSync(app.file('.jot/shortcuts.json')).size)
    await app.reopen({ removeIndex: true })
    await app.call('vault:rebuildIndex', undefined)
    expect(await app.call('extensions:configuration', undefined)).toEqual(config)
    expect(await app.call('shortcuts:get', undefined)).toEqual(shortcuts)
    expect(fs.existsSync(app.file('.jot/assistant.json')) ? fs.readFileSync(app.file('.jot/assistant.json'), 'utf8') : null).toBe(assistant)
    expect(fs.readdirSync(app.file('.jot')).some(name => name.startsWith('.jot-write.'))).toBe(false)
    expect(app.fake.requests).toHaveLength(0)
  })

  it('配置损坏明确报错，不当空配置覆盖；一个配置损坏不影响其他配置', async () => {
    app = await testApp()
    app.write('.jot/app-extensions.json', '{broken')
    await expect(app.call('extensions:configuration', undefined)).rejects.toThrow('INVALID_INPUT')
    await expect(app.core.extensionState.saveConfiguration(createAppExtensionConfiguration())).rejects.toThrow('配置格式无效')
    expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe('{broken')
    await app.call('shortcuts:set', { schemaVersion: 1, pinned: ['core.theme'], bindings: [] })
    app.write('.jot/shortcuts.json', JSON.stringify({ schemaVersion: 2, pinned: [], bindings: [] }))
    await expect(app.call('shortcuts:get', undefined)).rejects.toThrow('INVALID_INPUT')
    await expect(app.call('shortcuts:set', createShortcutConfiguration())).rejects.toThrow('INVALID_INPUT')
    expect(JSON.parse(fs.readFileSync(app.file('.jot/shortcuts.json'), 'utf8')).schemaVersion).toBe(2)
    expect(await app.call('commands:list', {})).toHaveLength(3)
  })

  it('templates 可显式读取编辑，监听、增量和重建不把模板当内容材料', async () => {
    app = await testApp()
    const template = 'templates/工作/工作日记.md'
    const usage = await app.call('maintenance:usage', undefined)
    await app.core.vault.createText(template, '# 模板独有关键词\n\n今天完成：')
    await app.core.idle()
    expect((await app.call('doc:get', { ref: { path: template } })).body).toContain('模板独有关键词')
    expect(app.core.index.getDoc(template)).toBeNull()
    expect((await app.call('maintenance:usage', undefined)).contentBytes - usage.contentBytes).toBe(fs.statSync(app.file(template)).size)
    await app.call('maintenance:clearTemporary', { vaultPath: app.root, confirmed: true })
    expect(fs.existsSync(app.file(template))).toBe(true)
    expect((await app.call('vault:tree', {})).some(node => node.path === 'templates')).toBe(false)
    expect((await app.call('vault:tree', { dir: 'templates' }))[0]!.path).toBe('templates/工作')
    app.write('templates/外部模板.md', '# 外部模板')
    await app.call('vault:rebuildIndex', undefined)
    expect(app.core.index.allPaths().some(path => path.startsWith('templates/'))).toBe(false)
    expect((await app.call('library:query', {})).total).toBe(0)
    expect((await app.call('search:query', { text: '模板独有关键词' })).total).toBe(0)
    expect((await app.call('timeline:day', { date: '2026-11-19' })).entries).toEqual([])
    await expect(app.call('vault:refreshIndex', { paths: [template] })).rejects.toThrow('不参与内容索引')
    expect(await app.core.daily.run('2026-11-19')).toBe('empty')
    expect(app.fake.requests).toHaveLength(0)
  })
})
