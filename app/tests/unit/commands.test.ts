import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extensionCommandId } from '@shared/commands'
import { CommandService, type ExtensionCommandRegistration } from '../../electron/commands/service'
import { argSchemas } from '../../electron/ipc/schemas'
import { Core } from '../../electron/core'
import { deferred, testApp } from '../helpers/test-app'

describe('应用命令服务', () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined
  afterEach(async () => { await app?.close(); app = undefined })

  it('真实内置命令新建 inbox 笔记并切主题，无模型调用', async () => {
    const changed = vi.fn()
    app = await testApp((event, data) => changed(event, data))
    expect((await app.call('commands:list', { query: '主题' })).map(command => command.id)).toEqual(['core.theme'])
    const created = await app.call('commands:execute', { id: 'core.new-note' })
    expect(created.kind).toBe('open-note')
    if (created.kind !== 'open-note') throw new Error('结果不符')
    expect(created.created).toBe(true)
    expect(created.path).toMatch(/^inbox\/\d{4}\/\d{2}\//)
    expect(fs.statSync(app.file(created.path)).isFile()).toBe(true)
    expect(app.core.index.getDoc(created.path)?.title).toBe('未命名笔记')
    const another = await app.call('commands:execute', { id: 'core.new-note' })
    expect(another).not.toEqual(created)
    await app.call('settings:set', { appearance: { theme: 'light' } })
    expect(await app.call('commands:execute', { id: 'core.theme' })).toEqual({ kind: 'theme', theme: 'dark' })
    expect(app.core.settings.get().appearance.theme).toBe('dark')
    expect(changed.mock.calls.some(([event]) => event === 'settings:changed')).toBe(true)
    const commands = new CommandService(app.core, () => {}, () => true)
    await app.call('settings:set', { appearance: { theme: 'system' } })
    expect(await commands.execute('core.theme')).toEqual({ kind: 'theme', theme: 'light' })
    expect(await app.call('commands:execute', { id: 'core.command-palette' })).toEqual({ kind: 'command-palette' })
    expect(app.fake.requests).toHaveLength(0)
  })

  it('未打开库时笔记命令明确不可用，主题命令仍可执行', async () => {
    app = await testApp()
    const core = new Core({ userDataDir: path.join(app.tmp.dir, 'no-vault-user'), secrets: { encrypt: value => value, decrypt: value => value }, devModel: null, emit: () => {} })
    try {
      await core.settings.load()
      expect(core.commands.list().find(command => command.id === 'core.new-note')?.availability).toEqual({ available: false, reason: '请先打开笔记库' })
      await expect(core.commands.execute('core.new-note')).rejects.toThrow('请先打开笔记库')
      expect((await core.commands.execute('core.theme')).kind).toBe('theme')
    } finally { await core.dispose() }
  })

  it('不同插件和配置使用稳定标识，改名不影响绑定，重复注册失败保持原命令', async () => {
    app = await testApp()
    const entry: ExtensionCommandRegistration = { profileId: 'daily', commandId: 'today', name: '我的日记', icon: 'book-open', availability: () => ({ available: true }), execute: async () => ({ kind: 'theme', theme: 'light' }) }
    app.core.commands.replaceExtension('personal-diary', [entry])
    app.core.commands.replaceExtension('work-diary', [entry])
    const id = extensionCommandId('personal-diary', 'daily', 'today')
    const shortcuts = { schemaVersion: 1 as const, pinned: [id], bindings: [{ commandId: id, hotkey: 'Ctrl+Shift+D' }] }
    await app.call('shortcuts:set', shortcuts)
    app.core.commands.replaceExtension('personal-diary', [{ ...entry, name: '改名后的日记' }])
    expect((await app.call('commands:list', { query: '改名' }))[0]!.id).toBe(id)
    expect(await app.call('shortcuts:get', undefined)).toEqual(shortcuts)
    expect(() => app!.core.commands.replaceExtension('personal-diary', [entry, entry])).toThrow('重复')
    expect((await app.call('commands:list', { query: '改名' }))[0]!.id).toBe(id)
    expect(() => app!.core.commands.replaceExtension('core', [entry])).toThrow('标识无效')
  })

  it('未知、不可用或被撤销的命令不执行，停用后保存的固定项保留', async () => {
    app = await testApp()
    const execute = vi.fn(async () => ({ kind: 'theme' as const, theme: 'light' as const }))
    const id = extensionCommandId('work-diary', 'daily', 'today')
    app.core.commands.replaceExtension('work-diary', [{ profileId: 'daily', commandId: 'today', name: '工作日记', icon: 'book-open', availability: () => ({ available: false, reason: '请先选择保存目录' }), execute }])
    expect((await app.call('commands:list', {})).some(command => command.id === id)).toBe(false)
    expect((await app.call('commands:list', { availableOnly: false })).find(command => command.id === id)?.availability).toEqual({ available: false, reason: '请先选择保存目录' })
    await expect(app.call('commands:execute', { id })).rejects.toThrow('请先选择保存目录')
    await app.call('shortcuts:set', { schemaVersion: 1, pinned: [id], bindings: [] })
    app.core.commands.replaceExtension('work-diary', [])
    await expect(app.call('commands:execute', { id })).rejects.toThrow('NOT_FOUND')
    expect(await app.call('shortcuts:get', undefined)).toEqual({ schemaVersion: 1, pinned: [id], bindings: [] })
    expect(execute).not.toHaveBeenCalled()
    expect(argSchemas['commands:execute'].safeParse({ id: 'core.theme', args: { code: 'arbitrary' } }).success).toBe(false)
    await expect(app.call('shortcuts:set', { schemaVersion: 1, pinned: ['extension:missing:daily:today'], bindings: [] })).rejects.toThrow('NOT_FOUND')
  })

  it('快捷键与捕获入口、编辑键或其他命令冲突时不覆盖原配置', async () => {
    app = await testApp()
    const saved = await app.call('shortcuts:set', { schemaVersion: 1, pinned: ['core.theme'], bindings: [{ commandId: 'core.theme', hotkey: 'Ctrl+Shift+D' }] })
    await expect(app.call('shortcuts:set', { ...saved, bindings: [{ commandId: 'core.theme', hotkey: 'Ctrl+Alt+N' }] })).rejects.toThrow('快速记录快捷键冲突')
    await expect(app.call('shortcuts:set', { ...saved, bindings: [{ commandId: 'core.theme', hotkey: 'Ctrl+Shift+D' }, { commandId: 'core.new-note', hotkey: 'Shift+Ctrl+d' }] })).rejects.toThrow('INVALID_INPUT')
    await expect(app.call('shortcuts:set', { ...saved, bindings: [{ commandId: 'core.theme', hotkey: 'Ctrl+E' }] })).rejects.toThrow('INVALID_INPUT')
    expect(await app.call('shortcuts:get', undefined)).toEqual(saved)
    await app.call('settings:set', { capture: { hotkey: 'Ctrl+Alt+K' } })
    await expect(app.call('shortcuts:set', { ...saved, bindings: [{ commandId: 'core.theme', hotkey: 'Ctrl+Alt+K' }] })).rejects.toThrow('快速记录快捷键冲突')
  })

  it('目录链接不能把日记目标引到 content 外，预览不修改目标', async () => {
    app = await testApp()
    const external = path.join(app.tmp.dir, 'outside-content')
    fs.mkdirSync(external)
    fs.symlinkSync(external, app.file('content/库外链接'), 'junction')
    fs.symlinkSync(app.file('templates'), app.file('content/模板链接'), 'junction')
    for (const directory of ['content/库外链接', 'content/模板链接']) {
      await expect(app.call('extensions:previewDateNote', { directory, filename: '{{yyyy}}-{{MM}}-{{dd}}.md' })).rejects.toThrow('PATH_OUTSIDE_VAULT')
    }
    expect(fs.readdirSync(external)).toEqual([])
    expect(fs.readdirSync(app.file('templates'))).toEqual([])
  })

  it('路径预览只读取一次时钟，不创建目录或笔记', async () => {
    app = await testApp()
    const clock = vi.spyOn(app.core, 'now').mockReturnValue(new Date(2027, 0, 1, 0, 0))
    const result = await app.call('extensions:previewDateNote', { directory: 'content/工作/工作日记/{{yyyy}}年-{{MM}}月', filename: '{{dd}}日 工作日记' })
    expect(clock).toHaveBeenCalledTimes(1)
    expect(result.path).toBe('content/工作/工作日记/2027年-01月/01日 工作日记.md')
    expect(fs.existsSync(app.file(result.directory))).toBe(false)
    expect(app.fake.requests).toHaveLength(0)
  })

  it('切库撤销旧命令，已经等待中的命令不能写进新库，配置按库隔离', async () => {
    app = await testApp()
    const entered = deferred()
    const resume = deferred()
    const id = extensionCommandId('work-diary', 'daily', 'today')
    app.core.commands.replaceExtension('work-diary', [{ profileId: 'daily', commandId: 'today', name: '工作日记', icon: 'book-open', availability: () => ({ available: true }), execute: async context => {
      entered.release()
      await resume.promise
      const meta = await context.mutate(() => app!.core.vault.createNote({ title: '不能跨库写入' }))
      return { kind: 'open-note', path: meta.path, created: true }
    } }])
    const original = await app.call('shortcuts:set', { schemaVersion: 1, pinned: [id], bindings: [] })
    const execution = app.call('commands:execute', { id })
    const rejected = expect(execution).rejects.toThrow('笔记库已切换')
    await entered.promise
    const newRoot = path.join(app.tmp.dir, 'second-vault')
    await app.call('vault:open', { path: newRoot, create: true })
    await app.core.jobs.stop()
    resume.release()
    await rejected
    expect(await app.call('shortcuts:get', undefined)).toEqual({ schemaVersion: 1, pinned: [], bindings: [] })
    expect((await app.call('commands:list', {})).some(command => command.id === id)).toBe(false)
    expect(await app.core.vault.listFiles()).toEqual([])
    await app.call('vault:open', { path: app.root, create: false })
    await app.core.jobs.stop()
    expect(await app.call('shortcuts:get', undefined)).toEqual(original)
  })
})
