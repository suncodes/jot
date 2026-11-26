import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extensionCommandId } from '@shared/commands'
import { createWorkReportOptions, previewWorkReportMonth, type WorkReportOptions } from '@shared/work-reports'
import { parseDoc } from '../../electron/vault/frontmatter'
import { localIso } from '../../electron/util/time'
import { testApp } from '../helpers/test-app'

const bundledRoot = path.resolve(import.meta.dirname, '../../resources/app-extensions')
const commandId = extensionCommandId('work-diary', 'today', 'today')
const now = new Date(2026, 10, 24, 12)
const options = (): WorkReportOptions => ({
  ...createWorkReportOptions(), root: 'content/研发/工作', draftDirectory: '草稿/{{yyyy}}年/{{MM}}月',
  reportDirectory: '正式/{{yyyy}}-{{MM}}', worklogDirectory: 'content/工程日志', filename: '{{dd}}日.md',
  template: { kind: 'package', path: 'templates/default.md' }, okrTemplate: { kind: 'package', path: 'templates/okr.md' },
})

describe('W2 工作日记配置与按需月份初始化', () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined
  const current = () => { if (!app) throw new Error('测试应用未创建'); return app }
  const install = async (id = 'work-diary') => {
    const preview = await current().call('extensions:previewImport', { source: { kind: 'bundled', id } })
    expect(preview?.issues).toEqual([])
    return current().call('extensions:confirmImport', { token: preview!.token })
  }
  const setup = async () => {
    app = await testApp()
    app.clock(now.toISOString())
    fs.cpSync(bundledRoot, app.appExtensionCandidates, { recursive: true })
    await install()
    return app
  }
  const configure = async (value = options()) => {
    const result = await current().call('extensions:saveProfile', { id: 'work-diary',
      profile: { id: 'today', commandId: 'today', name: '写工作草稿', options: value },
      shortcut: { pinned: true, hotkey: 'Ctrl+Alt+D' } })
    await current().call('extensions:setEnabled', { id: 'work-diary', enabled: true })
    return result
  }
  const execute = () => current().call('commands:execute', { id: commandId })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (!app) return
    try { expect(app.fake.requests).toHaveLength(0) }
    finally { await app.close(); app = undefined }
  })

  it('候选包只提供一个工作入口，安装后停用待配置，不创建业务目录或第二个插件', async () => {
    app = await setup()
    const catalog = await app.call('extensions:catalog', undefined)
    expect(catalog.installed).toHaveLength(1)
    expect(catalog.installed[0]).toMatchObject({ id: 'work-diary', enabled: false, profiles: [{
      id: 'today', options: { root: null, worklogDirectory: null, okrTemplate: { kind: 'package', path: 'templates/okr.md' } },
      availability: { available: false, reason: '请选择工作根目录' },
    }] })
    expect(catalog.installed[0]!.manifest!.commands).toMatchObject([{ id: 'today', action: 'work-diary' }])
    expect(fs.existsSync(app.file('.jot/app-extensions/personal-diary'))).toBe(false)
    expect(await app.core.vault.listFiles()).toEqual([])
    expect((await app.call('shortcuts:get', undefined)).pinned).toEqual([])
  })

  it('月预览复用共享计算，只取时一次；配置和预览不创建目录或文件', async () => {
    app = await setup()
    await configure()
    const clock = vi.spyOn(app.core, 'now').mockReturnValue(now)
    const target = await app.call('extensions:previewWorkReport', options())
    expect(clock).toHaveBeenCalledTimes(1)
    expect(target).toEqual(previewWorkReportMonth(options(), now))
    expect(target.dailyDraft.path).toBe('content/研发/工作/草稿/2026年/11月/2、日报/24日.md')
    expect(target.directories).toHaveLength(8)
    expect(fs.existsSync(app.file(options().root!))).toBe(false)
    expect(fs.existsSync(app.file('content/工程日志'))).toBe(false)
  })

  it('配置只保存在所属入口，与快捷键一起保存，重启和删除索引后仍恢复同一命令', async () => {
    app = await setup()
    const profile = await configure()
    const expected = { schemaVersion: 1, extensions: { 'work-diary': { enabled: true, profiles: [profile] } } }
    expect(JSON.parse(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8'))).toEqual(expected)
    expect((await app.call('shortcuts:get', undefined)).bindings).toEqual([{ commandId, hotkey: 'Ctrl+Alt+D' }])
    await app.reopen({ removeIndex: true })
    expect(await app.call('extensions:configuration', undefined)).toEqual(expected)
    expect((await app.call('commands:list', {})).find(command => command.id === commandId)?.availability).toEqual({ available: true })
    expect(fs.existsSync(app.file(options().root!))).toBe(false)
  })

  it('首次点击补齐八分类目录，仅创建当天草稿与可选草稿OKR，内容索引正常可见', async () => {
    app = await setup()
    await configure()
    const target = previewWorkReportMonth(options(), now)
    app.write(target.reportDirectory + '/4、月报/保留.txt', '已存在的虚构材料')
    const checked = vi.spyOn(app.core.vault, 'contentDirectoryExists')
    expect(await execute()).toEqual({ kind: 'open-note', path: target.dailyDraft.path, created: true })
    expect(checked).toHaveBeenCalledExactlyOnceWith(target.draftDirectory)
    for (const directory of target.directories) expect(fs.statSync(app.file(directory)).isDirectory()).toBe(true)
    expect(fs.readFileSync(app.file(target.reportDirectory + '/4、月报/保留.txt'), 'utf8')).toBe('已存在的虚构材料')
    const files = (await app.core.vault.listFiles()).map(file => file.path)
    expect(files.sort()).toEqual([target.dailyDraft.path, target.draftOkrPath, target.reportDirectory + '/4、月报/保留.txt'].sort())
    const parsed = parseDoc(fs.readFileSync(app.file(target.dailyDraft.path), 'utf8'))
    expect(parsed.data).toEqual({ type: 'note', created: localIso(now) })
    expect(parsed.body).toContain('## 工程进展')
    expect(parseDoc(fs.readFileSync(app.file(target.draftOkrPath), 'utf8')).body).toContain('2026年11月 OKR')
    expect(app.core.index.getDoc(target.dailyDraft.path)).toMatchObject({ type: 'note', generatedByAi: false })
    expect((await app.call('jobs:list', {})).total).toBe(0)
    expect((await app.call('classify:inbox', {})).total).toBe(0)
  })

  it('当月草稿目录存在即跳过整套初始化，不检查报告目录，不读取OKR模板', async () => {
    app = await setup()
    await configure()
    const target = previewWorkReportMonth(options(), now)
    fs.mkdirSync(app.file(target.draftDirectory), { recursive: true })
    app.write(target.reportDirectory, '此处被用户文件占用，日记不应检查它')
    fs.unlinkSync(app.file('.jot/app-extensions/work-diary/templates/okr.md'))
    await app.call('extensions:catalog', undefined)
    const ensure = vi.spyOn(app.core.vault, 'ensureContentDirectories')
    const checked = vi.spyOn(app.core.vault, 'contentDirectoryExists')
    const read = vi.spyOn(app.core.templates, 'read')
    expect(await execute()).toMatchObject({ created: true })
    expect(checked).toHaveBeenCalledExactlyOnceWith(target.draftDirectory)
    expect(ensure).not.toHaveBeenCalled()
    expect(read.mock.calls.map(([, template]) => template)).toEqual([options().template])
    expect(fs.existsSync(app.file(target.draftDirectory + '/1、OKR'))).toBe(false)
    expect(fs.existsSync(app.file(target.draftDirectory + '/3、周报'))).toBe(false)
    expect(fs.readFileSync(app.file(target.reportDirectory), 'utf8')).toContain('用户文件占用')
  })

  it.each([null, { kind: 'none' } as const])('OKR选项为%j时按选择创建或省略草稿OKR', async okrTemplate => {
    app = await setup()
    const value = { ...options(), okrTemplate }
    await configure(value)
    await execute()
    const target = previewWorkReportMonth(value, now)
    expect(fs.existsSync(app.file(target.draftOkrPath))).toBe(okrTemplate !== null)
    if (okrTemplate) expect(parseDoc(fs.readFileSync(app.file(target.draftOkrPath), 'utf8')).body).toBe('')
    expect((await app.core.vault.listFiles()).length).toBe(okrTemplate === null ? 1 : 2)
  })

  it('已有草稿保持原字节和时间，模板已移除仍只打开；不补回已删除的报告目录', async () => {
    app = await setup()
    app.write('templates/工作.md', '# {{title}}')
    await configure({ ...options(), template: { kind: 'user', path: 'templates/工作.md' } })
    await execute()
    const target = previewWorkReportMonth(options(), now)
    const bytes = '---\r\ntype: note\r\ntags: [保留]\r\n---\r\n用户自己的工作草稿\r\n'
    app.write(target.dailyDraft.path, bytes)
    const mtime = fs.statSync(app.file(target.dailyDraft.path)).mtimeMs
    fs.unlinkSync(app.file('templates/工作.md'))
    fs.rmdirSync(app.file(target.reportDirectory + '/3、周报'))
    await app.call('extensions:catalog', undefined)
    const read = vi.spyOn(app.core.templates, 'read')
    expect(await execute()).toEqual({ kind: 'open-note', path: target.dailyDraft.path, created: false })
    expect(read).not.toHaveBeenCalled()
    expect(fs.readFileSync(app.file(target.dailyDraft.path), 'utf8')).toBe(bytes)
    expect(fs.statSync(app.file(target.dailyDraft.path)).mtimeMs).toBe(mtime)
    expect(fs.existsSync(app.file(target.reportDirectory + '/3、周报'))).toBe(false)
  })

  it('使用用户日报和OKR模板，变量一致展开；OKR原件在初始化期间出现也不覆盖', async () => {
    app = await setup()
    app.write('templates/日报.md', '# {{date}} {{title}}')
    app.write('templates/OKR.md', '# {{yyyy}}-{{MM}} {{title}}')
    await configure({ ...options(), template: { kind: 'user', path: 'templates/日报.md' }, okrTemplate: { kind: 'user', path: 'templates/OKR.md' } })
    const target = previewWorkReportMonth(options(), now)
    const ensure = app.core.vault.ensureContentDirectories.bind(app.core.vault)
    vi.spyOn(app.core.vault, 'ensureContentDirectories').mockImplementation(async directories => {
      await ensure(directories)
      app!.write(target.draftOkrPath, '# 初始化期间出现的用户目标\n')
    })
    await execute()
    expect(fs.readFileSync(app.file(target.draftOkrPath), 'utf8')).toBe('# 初始化期间出现的用户目标\n')
    expect(parseDoc(fs.readFileSync(app.file(target.dailyDraft.path), 'utf8')).body).toBe('# 2026-11-24 24日')
  })

  it('缺少OKR模板时先报错，未创建草稿月目录；修复后再次点击正常初始化', async () => {
    app = await setup()
    app.write('templates/OKR.md', '# {{yyyy}}年{{MM}}月')
    await configure({ ...options(), okrTemplate: { kind: 'user', path: 'templates/OKR.md' } })
    fs.unlinkSync(app.file('templates/OKR.md'))
    const target = previewWorkReportMonth(options(), now)
    await expect(execute()).rejects.toThrow('模板不存在')
    expect(fs.existsSync(app.file(target.draftDirectory))).toBe(false)
    app.write('templates/OKR.md', '# {{yyyy}}年{{MM}}月')
    expect(await execute()).toMatchObject({ created: true })
    expect(parseDoc(fs.readFileSync(app.file(target.draftOkrPath), 'utf8')).body).toBe('# 2026年11月')
  })

  it('同日并发只创建一份草稿和OKR，每次仍以同一草稿月目录为判断入口', async () => {
    app = await setup()
    await configure()
    const results = await Promise.all(Array.from({ length: 8 }, () => execute()))
    expect(results.filter(result => result.kind === 'open-note' && result.created)).toHaveLength(1)
    expect(new Set(results.filter(result => result.kind === 'open-note').map(result => result.path)).size).toBe(1)
    expect(await app.core.vault.listFiles()).toHaveLength(2)
  })

  it('跨年与跨月按点击时的本地日期初始化，每次执行只取一次时钟', async () => {
    app = await setup()
    await configure()
    const clock = vi.spyOn(app.core, 'now').mockReturnValue(new Date(2026, 11, 31, 23, 59))
    const first = await execute()
    expect(clock).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ path: 'content/研发/工作/草稿/2026年/12月/2、日报/31日.md' })
    clock.mockClear().mockReturnValue(new Date(2027, 0, 1, 0, 1))
    const second = await execute()
    expect(clock).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ path: 'content/研发/工作/草稿/2027年/01月/2、日报/01日.md' })
    expect(fs.existsSync(app.file('content/研发/工作/正式/2026-12/4、月报'))).toBe(true)
    expect(fs.existsSync(app.file('content/研发/工作/正式/2027-01/4、月报'))).toBe(true)
  })

  it('普通日记选项不能保存到工作动作，工作选项不能保存到普通日记，不隐式转换配置', async () => {
    app = await setup()
    await install('personal-diary')
    const before = fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')
    await expect(app.call('extensions:saveProfile', { id: 'work-diary', profile: { id: 'today', commandId: 'today', name: '无效',
      options: { directory: 'content/工作', filename: '{{yyyy}}-{{MM}}-{{dd}}.md', template: { kind: 'none' } } } })).rejects.toThrow('选项与清单动作不匹配')
    await expect(app.call('extensions:saveProfile', { id: 'personal-diary', profile: { id: 'today', commandId: 'today', name: '无效', options: options() } })).rejects.toThrow('选项与清单动作不匹配')
    expect(fs.readFileSync(app.file('.jot/app-extensions.json'), 'utf8')).toBe(before)
  })

  it('路径非法或草稿位置被文件占用明确报错，不写库外或猜测替代路径', async () => {
    app = await setup()
    for (const invalid of [{ ...options(), root: '../outside' }, { ...options(), worklogDirectory: 'inbox/日志' },
      { ...options(), reportDirectory: options().draftDirectory }, { ...options(), filename: '不分日期.md' }]) {
      await expect(app.call('extensions:previewWorkReport', invalid)).rejects.toThrow('INVALID_INPUT')
    }
    await configure()
    const target = previewWorkReportMonth(options(), now)
    app.write(target.draftDirectory, '这是文件')
    await expect(execute()).rejects.toThrow('目录位置已被文件或链接占用')
    expect(fs.existsSync(app.file(target.reportDirectory))).toBe(false)
    expect(fs.readFileSync(app.file(target.draftDirectory), 'utf8')).toBe('这是文件')
  })

  it('目录链接不能将月份初始化引向content之外', async () => {
    app = await setup()
    await configure()
    const outside = path.join(app.tmp.dir, 'outside')
    fs.mkdirSync(outside)
    fs.mkdirSync(app.file('content/研发'), { recursive: true })
    fs.symlinkSync(outside, app.file('content/研发/工作'), 'junction')
    await expect(execute()).rejects.toThrow('PATH_OUTSIDE_VAULT')
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('卸载只移除插件与绑定，工作草稿、目录和用户模板保留', async () => {
    app = await setup()
    await configure()
    await execute()
    const target = previewWorkReportMonth(options(), now)
    app.write('templates/保留.md', '# 用户模板')
    await app.call('extensions:uninstall', { id: 'work-diary', confirmed: true })
    expect(fs.existsSync(app.file(target.dailyDraft.path))).toBe(true)
    expect(fs.existsSync(app.file(target.draftOkrPath))).toBe(true)
    expect(fs.readFileSync(app.file('templates/保留.md'), 'utf8')).toBe('# 用户模板')
    expect((await app.call('shortcuts:get', undefined)).pinned).toEqual([])
    await expect(execute()).rejects.toThrow('NOT_FOUND')
  })
})
