import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppExtensionImportPreview, DailyNoteOptions } from '@shared/app-extensions'
import { extensionCommandId } from '@shared/commands'
import { argSchemas } from '../../electron/ipc/schemas'
import { appExtensionSource } from '../helpers/app-extension'
import { deferred, testApp } from '../helpers/test-app'

describe('应用插件管理', () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined
  const current = () => { if (!app) throw new Error('测试应用未创建'); return app }
  const configured: DailyNoteOptions = { directory: 'content/虚构日记/{{yyyy}}年-{{MM}}月', filename: '{{dd}}.md', template: { kind: 'package', path: 'templates/default.md' } }
  const source = (id: string, version = '1.0.0') => appExtensionSource(path.join(current().tmp.dir, 'sources', version), id, { version })
  const preview = async (root: string, updating?: string): Promise<AppExtensionImportPreview> => {
    current().core.extensions.setPlatform({ pickDirectory: async () => root })
    const result = await current().call('extensions:previewImport', { source: { kind: 'local' }, updating })
    if (!result) throw new Error('没有返回安装预览')
    return result
  }
  const install = async (id: string) => {
    const pkg = source(id)
    const pending = await preview(pkg.root)
    await current().call('extensions:confirmImport', { token: pending.token })
    return pkg
  }
  const save = (id: string, options: DailyNoteOptions = configured) => current().call('extensions:saveProfile', { id, profile: { id: 'today', commandId: 'today', name: '自定义入口', options } })
  const commandId = (id: string, profileId = 'today') => extensionCommandId(id, profileId, 'today')

  afterEach(async () => {
    vi.restoreAllMocks()
    if (!app) return
    try { expect(app.fake.requests).toHaveLength(0) }
    finally { await app.close(); app = undefined }
  })

  it('安装前只有预览；确认完整复制，默认停用且不固定、不创建笔记', async () => {
    app = await testApp()
    const pkg = source('personal-diary')
    pkg.write('assets/sample.bin', Buffer.from([0, 1, 2, 255]))
    pkg.write('empty/.keep', '')
    const pending = await preview(pkg.root)
    expect(pending).toMatchObject({ manifest: { id: 'personal-diary', version: '1.0.0' }, updating: false, previousVersion: null, issues: [], removedFiles: [] })
    expect(pending.files.some(file => file.path === 'assets/sample.bin' && file.bytes === 4)).toBe(true)
    expect(fs.readdirSync(app.file('.jot/app-extensions'))).toEqual([])
    expect(fs.existsSync(app.file('.jot/app-extensions.json'))).toBe(false)
    const catalog = await app.call('extensions:confirmImport', { token: pending.token })
    expect(catalog.installed[0]).toMatchObject({ id: 'personal-diary', enabled: false, missing: false, issues: [], profiles: [{ id: 'today', availability: { available: false, reason: '请选择保存目录' } }] })
    expect(fs.readFileSync(app.file('.jot/app-extensions/personal-diary/assets/sample.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect((await app.call('shortcuts:get', undefined)).pinned).toEqual([])
    expect(await app.core.vault.listFiles()).toEqual([])
    expect((await app.call('commands:list', {})).every(command => command.source.kind === 'core')).toBe(true)
    await expect(app.call('extensions:confirmImport', { token: pending.token })).rejects.toThrow('CONFLICT')
  })

  it('取消预览、取消系统选择和用新预览替换旧预览均不落盘', async () => {
    app = await testApp()
    const personal = source('personal-diary'), work = source('work-diary')
    const cancelled = await preview(personal.root)
    await app.call('extensions:cancelImport', { token: cancelled.token })
    await expect(app.call('extensions:confirmImport', { token: cancelled.token })).rejects.toThrow('预览已失效')
    const previous = await preview(personal.root)
    const latest = await preview(work.root)
    await expect(app.call('extensions:confirmImport', { token: previous.token })).rejects.toThrow('预览已失效')
    await app.call('extensions:cancelImport', { token: latest.token })
    app.core.extensions.setPlatform({ pickDirectory: async () => null })
    expect(await app.call('extensions:previewImport', { source: { kind: 'local' } })).toBeNull()
    expect(fs.readdirSync(app.file('.jot/app-extensions'))).toEqual([])
    expect(fs.existsSync(app.file('.jot/app-extensions.json'))).toBe(false)
  })

  it('候选包仅供查看和选择安装，坏候选单独诊断，不自动安装', async () => {
    app = await testApp()
    appExtensionSource(app.appExtensionCandidates, 'personal-diary')
    const broken = appExtensionSource(app.appExtensionCandidates, 'broken-diary')
    broken.write('extension.json', '{broken')
    const catalog = await app.call('extensions:catalog', undefined)
    expect(catalog.installed).toEqual([])
    expect(catalog.candidates.find(candidate => candidate.id === 'personal-diary')?.issues).toEqual([])
    expect(catalog.candidates.find(candidate => candidate.id === 'broken-diary')?.issues[0]).toContain('有效的 JSON')
    const pending = await app.call('extensions:previewImport', { source: { kind: 'bundled', id: 'personal-diary' } })
    expect(pending?.manifest.id).toBe('personal-diary')
    const installed = await app.call('extensions:confirmImport', { token: pending!.token })
    expect(installed.installed.map(entry => entry.id)).toEqual(['personal-diary'])
    expect(installed.candidates).toHaveLength(2)
  })

  it('同ID安装与确认期间出现的同ID目录明确冲突，不覆盖已有文件', async () => {
    app = await testApp()
    const pkg = await install('work-diary')
    await expect(preview(pkg.root)).rejects.toThrow('CONFLICT')
    const other = source('personal-diary')
    const pending = await preview(other.root)
    app.write('.jot/app-extensions/personal-diary/manual.md', '确认前出现的资料')
    await expect(app.call('extensions:confirmImport', { token: pending.token })).rejects.toThrow('CONFLICT')
    expect(fs.readFileSync(app.file('.jot/app-extensions/personal-diary/manual.md'), 'utf8')).toBe('确认前出现的资料')
    expect(fs.readFileSync(app.file('.jot/app-extensions/work-diary/templates/default.md'), 'utf8')).toContain('虚构日记模板')
  })

  it('两个插件可独立配置启停；配置完整后注册真实可用命令', async () => {
    app = await testApp()
    await install('personal-diary')
    await install('work-diary')
    await save('personal-diary')
    await save('work-diary')
    await app.call('extensions:setEnabled', { id: 'personal-diary', enabled: true })
    const personal = commandId('personal-diary'), work = commandId('work-diary')
    const commands = await app.call('commands:list', { availableOnly: false })
    expect(commands.find(command => command.id === personal)?.availability).toEqual({ available: true })
    expect(commands.some(command => command.id === work)).toBe(false)
    await app.call('shortcuts:set', { schemaVersion: 1, pinned: [personal], bindings: [{ commandId: personal, hotkey: 'Ctrl+Shift+D' }] })
    const before = await app.call('shortcuts:get', undefined)
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    await app.call('extensions:setEnabled', { id: 'personal-diary', enabled: false })
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === personal)).toBe(false)
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === work)).toBe(true)
    expect(await app.call('shortcuts:get', undefined)).toEqual(before)
    await app.call('extensions:setEnabled', { id: 'personal-diary', enabled: true })
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === personal)).toBe(true)
    expect(await app.core.vault.listFiles()).toEqual([])
  })

  it('入口新增、改名和删除保持稳定身份，只清理本入口的快捷引用', async () => {
    app = await testApp()
    await install('work-diary')
    await save('work-diary')
    const added = await app.call('extensions:saveProfile', { id: 'work-diary', profile: { commandId: 'today', name: '第二个入口', options: configured } })
    expect(added.id).not.toBe('today')
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    const first = commandId('work-diary'), second = commandId('work-diary', added.id)
    const shortcuts = { schemaVersion: 1 as const, pinned: [second, 'core.theme', first], bindings: [{ commandId: first, hotkey: 'Ctrl+Shift+D' }, { commandId: second, hotkey: 'Ctrl+Shift+K' }] }
    await app.call('shortcuts:set', shortcuts)
    const renamed = await app.call('extensions:saveProfile', { id: 'work-diary', profile: { ...added, name: '改名后的入口' } })
    expect(renamed.id).toBe(added.id)
    expect(await app.call('shortcuts:get', undefined)).toEqual(shortcuts)
    expect((await app.call('commands:list', { query: '改名', availableOnly: false }))[0]?.id).toBe(second)
    await app.call('extensions:removeProfile', { id: 'work-diary', profileId: 'today' })
    expect(await app.call('shortcuts:get', undefined)).toEqual({ ...shortcuts, pinned: [second, 'core.theme'], bindings: [shortcuts.bindings[1]] })
    await app.call('extensions:removeProfile', { id: 'work-diary', profileId: added.id })
    await app.reopen()
    expect((await app.call('extensions:configuration', undefined)).extensions['work-diary']!.profiles).toEqual([])
  })

  it('更新完整替换资源，保留自定义配置、启停和固定顺序；安装使用预览快照', async () => {
    app = await testApp()
    const old = await install('work-diary')
    app.write('.jot/app-extensions/work-diary/old.md', '旧包独有资料')
    app.write('templates/我的工作模板.md', '# 自定义模板')
    await save('work-diary', { ...configured, template: { kind: 'user', path: 'templates/我的工作模板.md' } })
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    const shortcuts = await app.call('shortcuts:set', { schemaVersion: 1, pinned: ['core.theme', commandId('work-diary')], bindings: [] })
    const config = await app.call('extensions:configuration', undefined)
    const updated = source('work-diary', '2.0.0')
    updated.write('templates/default.md', '# 新包模板')
    const pending = await preview(updated.root, 'work-diary')
    expect(pending).toMatchObject({ updating: true, previousVersion: '1.0.0', removedFiles: ['old.md'], issues: [] })
    updated.write('templates/default.md', '# 预览之后又改过')
    const catalog = await app.call('extensions:confirmImport', { token: pending.token })
    expect(catalog.installed[0]?.manifest?.version).toBe('2.0.0')
    expect(fs.readFileSync(app.file('.jot/app-extensions/work-diary/templates/default.md'), 'utf8')).toBe('# 新包模板')
    expect(fs.existsSync(app.file('.jot/app-extensions/work-diary/old.md'))).toBe(false)
    expect(await app.call('extensions:configuration', undefined)).toEqual(config)
    expect(await app.call('shortcuts:get', undefined)).toEqual(shortcuts)
    expect(fs.readFileSync(path.join(old.root, 'extension.json'), 'utf8')).toContain('1.0.0')
    expect(fs.readFileSync(app.file('templates/我的工作模板.md'), 'utf8')).toBe('# 自定义模板')
  })

  it('更新删除的命令或模板保留配置并给出诊断，不静默改用新默认值', async () => {
    app = await testApp()
    await install('work-diary')
    await save('work-diary')
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    const next = source('work-diary', '2.0.0')
    next.manifest.commands[0]!.id = 'new-today'
    next.manifest.commands[0]!.defaults.template = { kind: 'none' }
    next.write('extension.json', JSON.stringify(next.manifest))
    fs.unlinkSync(path.join(next.root, 'templates/default.md'))
    const pending = await preview(next.root, 'work-diary')
    expect(pending.warnings).toHaveLength(2)
    const catalog = await app.call('extensions:confirmImport', { token: pending.token })
    expect(catalog.installed[0]?.profiles[0]).toMatchObject({ commandId: 'today', availability: { available: false, reason: '清单中已不存在此配置对应的命令' } })
    expect((await app.call('extensions:configuration', undefined)).extensions['work-diary']!.profiles[0]?.options.template).toEqual({ kind: 'package', path: 'templates/default.md' })
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === commandId('work-diary'))).toBe(false)
  })

  it('版本不满足和模板缺失阻止确认；坏清单或越界声明不留下包', async () => {
    app = await testApp()
    const newer = source('future-diary')
    newer.write('extension.json', JSON.stringify({ ...newer.manifest, minAppVersion: '99.0.0' }))
    const blocked = await preview(newer.root)
    expect(blocked.issues[0]).toContain('需要 Jot 99.0.0')
    await expect(app.call('extensions:confirmImport', { token: blocked.token })).rejects.toThrow('INVALID_INPUT')
    const missing = source('missing-template')
    fs.unlinkSync(path.join(missing.root, 'templates/default.md'))
    const missingPreview = await preview(missing.root)
    expect(missingPreview.issues[0]).toContain('缺少声明的模板')
    await expect(app.call('extensions:confirmImport', { token: missingPreview.token })).rejects.toThrow('INVALID_INPUT')
    const broken = source('broken-diary')
    broken.write('extension.json', 'not json')
    await expect(preview(broken.root)).rejects.toThrow('有效的 JSON')
    const escaped = source('escape-diary')
    escaped.manifest.commands[0]!.defaults.template = { kind: 'package', path: '../outside.md' }
    escaped.write('extension.json', JSON.stringify(escaped.manifest))
    await expect(preview(escaped.root)).rejects.toThrow('INVALID_INPUT')
    expect(fs.readdirSync(app.file('.jot/app-extensions'))).toEqual([])
  })

  it('卸载只移除所属包、配置和快捷引用，另一个插件及普通文件保留', async () => {
    app = await testApp()
    await install('personal-diary')
    await install('work-diary')
    for (const id of ['personal-diary', 'work-diary']) {
      await save(id)
      await app.call('extensions:setEnabled', { id, enabled: true })
    }
    app.write('content/工作/虚构日记.md', '# 既有普通笔记')
    app.write('templates/虚构模板.md', '# 用户模板')
    const personal = commandId('personal-diary'), work = commandId('work-diary')
    await app.call('shortcuts:set', { schemaVersion: 1, pinned: [work, personal, 'core.theme'], bindings: [{ commandId: work, hotkey: 'Ctrl+Shift+D' }, { commandId: personal, hotkey: 'Ctrl+Shift+K' }] })
    const other = (await app.call('extensions:configuration', undefined)).extensions['personal-diary']
    const catalog = await app.call('extensions:uninstall', { id: 'work-diary', confirmed: true })
    expect(catalog.installed.map(entry => entry.id)).toEqual(['personal-diary'])
    expect((await app.call('extensions:configuration', undefined)).extensions).toEqual({ 'personal-diary': other })
    expect(await app.call('shortcuts:get', undefined)).toEqual({ schemaVersion: 1, pinned: [personal, 'core.theme'], bindings: [{ commandId: personal, hotkey: 'Ctrl+Shift+K' }] })
    expect(fs.existsSync(app.file('.jot/app-extensions/work-diary'))).toBe(false)
    expect(fs.readFileSync(app.file('content/工作/虚构日记.md'), 'utf8')).toBe('# 既有普通笔记')
    expect(fs.readFileSync(app.file('templates/虚构模板.md'), 'utf8')).toBe('# 用户模板')
    expect(fs.existsSync(app.file('.jot/app-extensions/personal-diary/extension.json'))).toBe(true)
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === work)).toBe(false)
  })

  it('更新替换失败恢复旧包和配置，安装预览可重试', async () => {
    app = await testApp()
    await install('work-diary')
    await save('work-diary')
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    const before = fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')
    const pending = await preview(source('work-diary', '2.0.0').root, 'work-diary')
    const rename = fs.promises.rename.bind(fs.promises)
    const failing = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(from)) === 'next' && String(to) === app!.file('.jot/app-extensions/work-diary')) throw new Error('虚构替换失败')
      return rename(from, to)
    })
    await expect(app.call('extensions:confirmImport', { token: pending.token })).rejects.toThrow('虚构替换失败')
    failing.mockRestore()
    expect(JSON.parse(fs.readFileSync(app.file('.jot/app-extensions/work-diary/extension.json'), 'utf8')).version).toBe('1.0.0')
    expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe(before)
    expect(fs.readdirSync(app.file('.jot/app-extensions')).some(name => name.startsWith('.jot-package-'))).toBe(false)
    expect((await app.call('extensions:confirmImport', { token: pending.token })).installed[0]?.manifest?.version).toBe('2.0.0')
  })

  it('首次安装的配置保存失败撤销已复制的包，不留下半安装状态', async () => {
    app = await testApp()
    const pending = await preview(source('work-diary').root)
    const rename = fs.promises.rename.bind(fs.promises)
    const failing = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === app!.file('.jot/app-extensions.json')) throw new Error('虚构配置保存失败')
      return rename(from, to)
    })
    await expect(app.call('extensions:confirmImport', { token: pending.token })).rejects.toThrow('虚构配置保存失败')
    failing.mockRestore()
    expect(fs.readdirSync(app.file('.jot/app-extensions'))).toEqual([])
    expect(fs.existsSync(app.file('.jot/app-extensions.json'))).toBe(false)
    expect((await app.call('extensions:confirmImport', { token: pending.token })).installed[0]?.id).toBe('work-diary')
  })

  it('卸载第二份JSON保存失败恢复第一份JSON和原包，不移除现有命令', async () => {
    app = await testApp()
    await install('work-diary')
    await save('work-diary')
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    await app.call('shortcuts:set', { schemaVersion: 1, pinned: [commandId('work-diary')], bindings: [] })
    const config = fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')
    const shortcuts = fs.readFileSync(app.file('.jot/shortcuts.json'), 'utf8')
    const rename = fs.promises.rename.bind(fs.promises)
    const failing = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === app!.file('.jot/shortcuts.json')) throw new Error('虚构快捷配置失败')
      return rename(from, to)
    })
    await expect(app.call('extensions:uninstall', { id: 'work-diary', confirmed: true })).rejects.toThrow('虚构快捷配置失败')
    failing.mockRestore()
    expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe(config)
    expect(fs.readFileSync(app.file('.jot/shortcuts.json'), 'utf8')).toBe(shortcuts)
    expect(fs.existsSync(app.file('.jot/app-extensions/work-diary/extension.json'))).toBe(true)
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === commandId('work-diary'))).toBe(true)
    expect(fs.readdirSync(app.file('.jot/app-extensions'))).toEqual(['work-diary'])
  })

  it('损坏或缺失包单独诊断并撤销命令，可以更新修复或卸载清理', async () => {
    app = await testApp()
    await install('personal-diary')
    await install('work-diary')
    for (const id of ['personal-diary', 'work-diary']) await app.call('extensions:setEnabled', { id, enabled: true })
    app.write('.jot/app-extensions/work-diary/extension.json', '{broken')
    let catalog = await app.call('extensions:catalog', undefined)
    expect(catalog.installed.find(entry => entry.id === 'work-diary')?.issues[0]).toContain('有效的 JSON')
    expect(catalog.installed.find(entry => entry.id === 'personal-diary')?.issues).toEqual([])
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === commandId('work-diary'))).toBe(false)
    const fix = await preview(source('work-diary', '2.0.0').root, 'work-diary')
    expect(fix.warnings[0]).toContain('当前包损坏')
    await app.call('extensions:confirmImport', { token: fix.token })
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === commandId('work-diary'))).toBe(true)
    await fs.promises.rm(app.file('.jot/app-extensions/work-diary'), { recursive: true, force: true })
    catalog = await app.call('extensions:catalog', undefined)
    expect(catalog.installed.find(entry => entry.id === 'work-diary')).toMatchObject({ missing: true, enabled: true })
    await app.call('extensions:uninstall', { id: 'work-diary', confirmed: true })
    expect((await app.call('extensions:configuration', undefined)).extensions['work-diary']).toBeUndefined()
  })

  it('损坏JSON不阻断普通开库；明确诊断，写操作不覆盖损坏内容', async () => {
    app = await testApp()
    await install('work-diary')
    app.write('.jot/app-extensions.json', '{broken')
    await app.reopen()
    expect(app.core.vault.isOpen).toBe(true)
    const catalog = await app.call('extensions:catalog', undefined)
    expect(catalog.issues[0]).toContain('配置格式无效')
    expect(catalog.installed[0]?.enabled).toBeNull()
    expect((await app.call('commands:list', {})).map(command => command.id)).toEqual(['core.new-note', 'core.command-palette', 'core.theme'])
    await expect(app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })).rejects.toThrow('配置格式无效')
    await expect(app.call('extensions:uninstall', { id: 'work-diary', confirmed: true })).rejects.toThrow('配置格式无效')
    expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe('{broken')
  })

  it('系统目录选择期间切库，迟到结果及旧预览都不能写入新库', async () => {
    app = await testApp()
    const pkg = source('work-diary')
    const old = await preview(pkg.root)
    const entered = deferred(), resume = deferred()
    app.core.extensions.setPlatform({ pickDirectory: async () => { entered.release(); await resume.promise; return pkg.root } })
    const selecting = app.call('extensions:previewImport', { source: { kind: 'local' } })
    const rejected = expect(selecting).rejects.toThrow('笔记库已切换')
    await entered.promise
    await expect(app.call('extensions:previewImport', { source: { kind: 'local' } })).rejects.toThrow('目录选择')
    await app.call('vault:open', { path: path.join(app.tmp.dir, 'second-vault'), create: true })
    await app.core.jobs.stop()
    resume.release()
    await rejected
    await expect(app.call('extensions:confirmImport', { token: old.token })).rejects.toThrow('预览已失效')
    expect(await app.call('extensions:configuration', undefined)).toEqual({ schemaVersion: 1, extensions: {} })
    expect(fs.readdirSync(app.core.vault.abs('.jot/app-extensions'))).toEqual([])
  })

  it('重启和删索引恢复真实安装状态，切到另一库清空命令再切回恢复', async () => {
    app = await testApp()
    await install('work-diary')
    await save('work-diary')
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    const shortcuts = await app.call('shortcuts:set', { schemaVersion: 1, pinned: [commandId('work-diary')], bindings: [] })
    const configuration = await app.call('extensions:configuration', undefined)
    await app.reopen({ removeIndex: true })
    expect(await app.call('extensions:configuration', undefined)).toEqual(configuration)
    expect(await app.call('shortcuts:get', undefined)).toEqual(shortcuts)
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === commandId('work-diary'))).toBe(true)
    await app.call('vault:open', { path: path.join(app.tmp.dir, 'other-vault'), create: true })
    await app.core.jobs.stop()
    expect((await app.call('extensions:catalog', undefined)).installed).toEqual([])
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.source.kind === 'extension')).toBe(false)
    await app.call('vault:open', { path: app.root, create: false })
    await app.core.jobs.stop()
    expect(await app.call('extensions:configuration', undefined)).toEqual(configuration)
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === commandId('work-diary'))).toBe(true)
  })

  it('打开新库失败后恢复仍打开库的插件命令，切库事件在操作结束后推送', async () => {
    const events: string[] = []
    app = await testApp(event => events.push(event))
    await install('work-diary')
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    const configuration = await app.call('extensions:configuration', undefined)
    await expect(app.call('vault:open', { path: path.join(app.tmp.dir, 'does-not-exist'), create: false })).rejects.toThrow('NOT_FOUND')
    expect(app.core.vault.path).toBe(app.root)
    expect(app.core.commands.isChangingVault).toBe(false)
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === commandId('work-diary'))).toBe(true)
    expect(await app.call('extensions:configuration', undefined)).toEqual(configuration)
    expect(events.at(-1)).toBe('extensions:changed')
  })

  it('已经开始的启用先完成，切库随后清理它刚注册的旧库命令', async () => {
    app = await testApp()
    await install('work-diary')
    const entered = deferred(), resume = deferred()
    const saveChanges = app.core.extensionState.saveChanges.bind(app.core.extensionState)
    vi.spyOn(app.core.extensionState, 'saveChanges').mockImplementation(async input => {
      entered.release()
      await resume.promise
      return saveChanges(input)
    })
    const enabling = app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    await entered.promise
    const switching = app.call('vault:open', { path: path.join(app.tmp.dir, 'new-vault'), create: true })
    expect(app.core.commands.isChangingVault).toBe(true)
    resume.release()
    await enabling
    await switching
    await app.core.jobs.stop()
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.source.kind === 'extension')).toBe(false)
    expect((await app.call('extensions:catalog', undefined)).installed).toEqual([])
    expect(JSON.parse(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).extensions['work-diary'].enabled).toBe(true)
    expect(fs.existsSync(app.core.vault.abs('.jot/app-extensions.json'))).toBe(false)
  })

  it('文件链接不导入或跟随；卸载损坏的目录链接不触碰链接目标', async () => {
    app = await testApp()
    const linked = source('linked-diary')
    const outside = path.join(app.tmp.dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.md'), '不能删除的虚构外部资料')
    fs.symlinkSync(outside, path.join(linked.root, 'link'), 'junction')
    await expect(preview(linked.root)).rejects.toThrow('目录只能包含普通文件和文件夹')
    fs.symlinkSync(outside, app.file('.jot/app-extensions/linked-diary'), 'junction')
    const catalog = await app.call('extensions:catalog', undefined)
    expect(catalog.installed[0]?.issues[0]).toContain('不能使用链接')
    await app.call('extensions:uninstall', { id: 'linked-diary', confirmed: true })
    expect(fs.readFileSync(path.join(outside, 'keep.md'), 'utf8')).toBe('不能删除的虚构外部资料')
    expect(fs.existsSync(app.file('.jot/app-extensions/linked-diary'))).toBe(false)
  })

  it('配置验证真实模板与目录边界；坏输入不覆盖已有配置', async () => {
    app = await testApp()
    await install('work-diary')
    const before = fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')
    for (const template of [{ kind: 'user', path: 'templates/missing.md' }, { kind: 'package', path: 'templates/missing.md' }] as const) {
      await expect(save('work-diary', { ...configured, template })).rejects.toThrow('不存在')
    }
    await expect(save('work-diary', { ...configured, directory: '../outside' })).rejects.toThrow('INVALID_INPUT')
    await expect(app.call('extensions:saveProfile', { id: 'work-diary', profile: { id: 'missing', commandId: 'today', name: '无效', options: configured } })).rejects.toThrow('入口配置已不存在')
    expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe(before)
  })

  it('长标识和普通constructor目录可正常安装管理，不误读对象原型', async () => {
    app = await testApp()
    for (const id of ['a'.repeat(80), 'constructor']) {
      await install(id)
      await app.call('extensions:setEnabled', { id, enabled: true })
      expect((await app.call('extensions:catalog', undefined)).installed.find(entry => entry.id === id)?.enabled).toBe(true)
      await app.call('extensions:uninstall', { id, confirmed: true })
    }
    expect((await app.call('extensions:catalog', undefined)).installed).toEqual([])
  })

  it('独立固定动作由应用实现，包不获得任意IPC或脚本执行能力', async () => {
    app = await testApp()
    const action = vi.spyOn(app.core.dateNotes, 'execute')
    await install('work-diary')
    await save('work-diary')
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    expect(await app.call('commands:execute', { id: commandId('work-diary') })).toMatchObject({ kind: 'open-note', created: true })
    expect(action).toHaveBeenCalledTimes(1)
    expect(action.mock.calls[0]).toMatchObject(['work-diary', { id: 'today', name: '自定义入口', options: configured }, { vaultPath: app.root }])
    for (const args of [{ source: { kind: 'local', path: 'C:/secret' } }, { source: { kind: 'url', url: 'https://example.com' } }, { source: { kind: 'bundled', id: '../escape' } }]) {
      expect(argSchemas['extensions:previewImport'].safeParse(args).success).toBe(false)
    }
    expect(argSchemas['extensions:uninstall'].safeParse({ id: 'work-diary' }).success).toBe(false)
    expect(argSchemas['extensions:setEnabled'].safeParse({ id: '__proto__', enabled: true }).success).toBe(false)
    expect(argSchemas['commands:execute'].safeParse({ id: commandId('work-diary'), args: { ipc: 'settings:set' } }).success).toBe(false)
  })

  it('配置与固定快捷键一次保存；停用插件的配置也可固定，启用后沿用同一命令', async () => {
    app = await testApp()
    await install('work-diary')
    const profile = await app.call('extensions:saveProfile', { id: 'work-diary', profile: {
      commandId: 'today', name: 'X4工作记录', options: configured,
    }, shortcut: { pinned: true, hotkey: 'Shift+Ctrl+D' } })
    const id = extensionCommandId('work-diary', profile.id, profile.commandId)
    expect(await app.call('shortcuts:get', undefined)).toEqual({ schemaVersion: 1, pinned: [id], bindings: [{ commandId: id, hotkey: 'Ctrl+Shift+D' }] })
    expect((await app.call('extensions:configuration', undefined)).extensions['work-diary']!.enabled).toBe(false)
    expect((await app.call('commands:list', { availableOnly: false })).some(command => command.id === id)).toBe(false)
    await app.call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    expect((await app.call('commands:list', {})).find(command => command.id === id)?.name).toBe('X4工作记录')
    await app.call('extensions:saveProfile', { id: 'work-diary', profile: { ...profile, name: '重命名' }, shortcut: { pinned: false, hotkey: null } })
    expect((await app.call('extensions:configuration', undefined)).extensions['work-diary']!.profiles.find(current => current.id === profile.id)?.name).toBe('重命名')
    expect(await app.call('shortcuts:get', undefined)).toEqual({ schemaVersion: 1, pinned: [], bindings: [] })
    expect(app.fake.requests).toHaveLength(0)
  })

  it.each(['Ctrl+N', 'Ctrl+Alt+N', 'Ctrl+Shift+D'])('快捷键冲突 %s 时新配置和现有配置均不落盘', async hotkey => {
    app = await testApp()
    await install('personal-diary'); await install('work-diary')
    await save('personal-diary')
    await app.call('shortcuts:set', { schemaVersion: 1, pinned: [commandId('personal-diary')], bindings: [{ commandId: commandId('personal-diary'), hotkey: 'Ctrl+Shift+D' }] })
    const config = fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')
    const shortcuts = fs.readFileSync(app.file('.jot/shortcuts.json'), 'utf8')
    for (const id of [undefined, 'today']) {
      await expect(app.call('extensions:saveProfile', { id: 'work-diary',
        profile: { ...(id ? { id } : {}), commandId: 'today', name: '不得落盘的修改', options: configured },
        shortcut: { pinned: true, hotkey },
      })).rejects.toThrow()
      expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe(config)
      expect(fs.readFileSync(app.file('.jot/shortcuts.json'), 'utf8')).toBe(shortcuts)
    }
  })

  it('配置保存时第二份JSON写入失败，回滚第一份配置和原快捷键', async () => {
    app = await testApp(); await install('work-diary'); await save('work-diary')
    await app.call('shortcuts:set', { schemaVersion: 1, pinned: [], bindings: [] })
    const config = fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')
    const shortcuts = fs.readFileSync(app.file('.jot/shortcuts.json'), 'utf8')
    const rename = fs.promises.rename.bind(fs.promises)
    const failing = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === app!.file('.jot/shortcuts.json')) throw new Error('虚构绑定写入失败')
      return rename(from, to)
    })
    try {
      await expect(app.call('extensions:saveProfile', { id: 'work-diary', profile: { id: 'today', commandId: 'today', name: '不可留下的改名', options: configured },
        shortcut: { pinned: true, hotkey: 'Ctrl+Shift+D' },
      })).rejects.toThrow('虚构绑定写入失败')
    } finally { failing.mockRestore() }
    expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe(config)
    expect(fs.readFileSync(app.file('.jot/shortcuts.json'), 'utf8')).toBe(shortcuts)
  })

  it('修改全局捕获快捷键也校验已有应用绑定；冲突不修改其他设置', async () => {
    app = await testApp(); await install('work-diary'); await save('work-diary')
    await app.call('shortcuts:set', { schemaVersion: 1, pinned: [], bindings: [{ commandId: commandId('work-diary'), hotkey: 'Ctrl+Shift+D' }] })
    const before = await app.call('settings:get', undefined)
    await expect(app.call('settings:set', { capture: { hotkey: 'Control+Shift+D' }, appearance: { theme: 'dark' } })).rejects.toThrow('快捷键冲突')
    expect(await app.call('settings:get', undefined)).toEqual(before)
    await app.call('settings:set', { capture: { hotkey: 'Ctrl+Alt+Y' } })
    expect((await app.call('settings:get', undefined)).capture.hotkey).toBe('Ctrl+Alt+Y')
  })
})
