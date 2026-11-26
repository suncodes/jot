import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DailyNoteOptions } from '@shared/app-extensions'
import { extensionCommandId } from '@shared/commands'
import { createWorkReportOptions } from '@shared/work-reports'
import { expandNoteTemplate } from '@shared/note-templates'
import { argSchemas } from '../../electron/ipc/schemas'
import { parseDoc } from '../../electron/vault/frontmatter'
import { localIso } from '../../electron/util/time'
import { appExtensionSource } from '../helpers/app-extension'
import { deferred, testApp } from '../helpers/test-app'

const bundledRoot = path.resolve(import.meta.dirname, '../../resources/app-extensions')
const command = (id = 'work-diary') => extensionCommandId(id, 'today', 'today')
const options: DailyNoteOptions = { directory: 'content/工作/工作日记/{{yyyy}}年-{{MM}}月', filename: '{{yyyy}}-{{MM}}-{{dd}} 工作日记.md', template: { kind: 'package', path: 'templates/default.md' } }

describe('日期笔记与独立日记插件', () => {
  let app: Awaited<ReturnType<typeof testApp>> | undefined
  const current = () => { if (!app) throw new Error('测试应用未创建'); return app }
  const install = async (id = 'work-diary') => {
    const pkg = appExtensionSource(path.join(current().tmp.dir, 'sources'), id)
    current().core.extensions.setPlatform({ pickDirectory: async () => pkg.root })
    const preview = await current().call('extensions:previewImport', { source: { kind: 'local' } })
    await current().call('extensions:confirmImport', { token: preview!.token })
    return pkg
  }
  const configure = async (value: DailyNoteOptions | import('@shared/work-reports').WorkReportOptions = options, id = 'work-diary') => {
    await current().call('extensions:saveProfile', { id, profile: { id: 'today', commandId: 'today', name: id, options: value } })
    await current().call('extensions:setEnabled', { id, enabled: true })
  }
  const execute = (id = 'work-diary') => current().call('commands:execute', { id: command(id) })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (!app) return
    try { expect(app.fake.requests).toHaveLength(0) }
    finally { await app.close(); app = undefined }
  })

  it('个人与工作两个候选包清单独立、默认停用待配置，只安装一个不创建另一个', async () => {
    app = await testApp()
    fs.cpSync(bundledRoot, app.appExtensionCandidates, { recursive: true })
    let catalog = await app.call('extensions:catalog', undefined)
    expect(catalog.candidates.map(pkg => pkg.id).sort()).toEqual(['personal-diary', 'work-diary'])
    expect(catalog.candidates.every(pkg => pkg.issues.length === 0)).toBe(true)
    for (const id of ['personal-diary', 'work-diary']) {
      const preview = await app.call('extensions:previewImport', { source: { kind: 'bundled', id } })
      catalog = await app.call('extensions:confirmImport', { token: preview!.token })
      expect(catalog.installed.find(pkg => pkg.id === id)).toMatchObject({ enabled: false, profiles: [{ options: id === 'work-diary' ? { root: null } : { directory: null } }] })
      if (id === 'personal-diary') expect(fs.existsSync(app.file('.jot/app-extensions/work-diary'))).toBe(false)
    }
    await configure({ ...options, directory: 'content/生活/个人日记/{{yyyy}}/{{MM}}', filename: '{{dd}}.md' }, 'personal-diary')
    await configure({ ...createWorkReportOptions(), root: 'content/工作/工作日记', template: options.template }, 'work-diary')
    const personal = await execute('personal-diary'), work = await execute()
    expect(personal).toMatchObject({ kind: 'open-note', created: true })
    expect(work).toMatchObject({ kind: 'open-note', created: true })
    if (personal.kind !== 'open-note' || work.kind !== 'open-note') throw new Error('日记命令未返回文件')
    expect(personal.path).not.toBe(work.path)
    expect(fs.readFileSync(app.file(personal.path), 'utf8')).toContain('今天想记下的')
    expect(fs.readFileSync(app.file(work.path), 'utf8')).toContain('今日记录')
    await app.call('extensions:uninstall', { id: 'personal-diary', confirmed: true })
    expect(await execute()).toMatchObject({ created: false, path: work.path })
    expect(fs.existsSync(app.file(personal.path))).toBe(true)
  })

  it('一次本地取时决定目录、文件名、模板变量和创建时间，创建普通笔记并更新索引', async () => {
    const changes: string[] = []
    app = await testApp(event => changes.push(event))
    const pkg = await install()
    pkg.write('templates/default.md', '# {{title}}\n\n{{date}} / {{yyyy}}年{{MM}}月{{dd}}日\n')
    app.write('.jot/app-extensions/work-diary/templates/default.md', '# {{title}}\n\n{{date}} / {{yyyy}}年{{MM}}月{{dd}}日\n')
    await configure()
    const now = new Date(2026, 11, 31, 23, 59, 59)
    const clock = vi.spyOn(app.core, 'now').mockReturnValue(now)
    const result = await execute()
    if (result.kind !== 'open-note') throw new Error('日记命令未返回文件')
    expect(clock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ kind: 'open-note', path: 'content/工作/工作日记/2026年-12月/2026-12-31 工作日记.md', created: true })
    const parsed = parseDoc(fs.readFileSync(app.file('content/工作/工作日记/2026年-12月/2026-12-31 工作日记.md'), 'utf8'))
    expect(parsed.body).toBe('# 2026-12-31 工作日记\n\n2026-12-31 / 2026年12月31日\n')
    expect(parsed.data).toEqual({ type: 'note', created: localIso(now) })
    expect(app.core.index.getDoc(result.path)).toMatchObject({ type: 'note', role: 'note', generatedByAi: false })
    expect(changes).toContain('vault:changed')
    expect((await app.call('classify:inbox', {})).total).toBe(0)
    expect((await app.call('jobs:list', {})).total).toBe(0)
  })

  it('相同或不同入口并发触发同一路径，只创建一次，不另存数字后缀', async () => {
    app = await testApp()
    await install()
    await configure()
    const extra = await app.call('extensions:saveProfile', { id: 'work-diary', profile: { commandId: 'today', name: '另一个入口', options } })
    const ids = [command(), extensionCommandId('work-diary', extra.id, 'today')]
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => app!.call('commands:execute', { id: ids[index % 2]! })))
    expect(results.filter(result => result.kind === 'open-note' && result.created)).toHaveLength(1)
    expect(new Set(results.filter(result => result.kind === 'open-note').map(result => result.path)).size).toBe(1)
    expect(await app.core.vault.listFiles()).toHaveLength(1)
  })

  it('已有文件保持字节、属性和时间，不读取或重套已删除的模板', async () => {
    app = await testApp()
    await install()
    app.write('templates/用户模板.md', '# {{title}}')
    await configure({ ...options, template: { kind: 'user', path: 'templates/用户模板.md' } })
    const target = await app.call('extensions:previewDateNote', { directory: options.directory!, filename: options.filename })
    const original = '---\r\ntype: note\r\ntags: [保留]\r\ncreated: 2001-01-01T12:00:00+08:00\r\n---\r\n原有正文\r\n'
    app.write(target.path, original)
    const before = fs.statSync(app.file(target.path)).mtimeMs
    fs.unlinkSync(app.file('templates/用户模板.md'))
    await app.call('extensions:catalog', undefined)
    const read = vi.spyOn(app.core.templates, 'read')
    expect(await execute()).toEqual({ kind: 'open-note', path: target.path, created: false })
    expect(read).not.toHaveBeenCalled()
    expect(fs.readFileSync(app.file(target.path), 'utf8')).toBe(original)
    expect(fs.statSync(app.file(target.path)).mtimeMs).toBe(before)
  })

  it('无模板时仍生成普通空白笔记，日期可全放目录中', async () => {
    app = await testApp()
    await install()
    await configure({ directory: 'content/生活/日记/{{yyyy}}/{{MM}}/{{dd}}', filename: '今天', template: { kind: 'none' } })
    const result = await execute()
    if (result.kind !== 'open-note') throw new Error('结果不符')
    expect(result.path).toMatch(/^content\/生活\/日记\/\d{4}\/\d{2}\/\d{2}\/今天\.md$/)
    expect(parseDoc(fs.readFileSync(app.file(result.path), 'utf8')).body).toBe('')
    expect((await app.call('doc:get', { ref: { path: result.path } })).type).toBe('note')
  })

  it('重启后包内模板丢失仍可打开已有日记，新日期创建显示缺失原因', async () => {
    app = await testApp()
    await install()
    await configure()
    const first = await execute()
    fs.unlinkSync(app.file('.jot/app-extensions/work-diary/templates/default.md'))
    await app.reopen()
    expect(await execute()).toEqual({ ...first, created: false })
    app.clock('2026-11-20T12:00:00+08:00')
    const catalog = await app.call('extensions:catalog', undefined)
    expect(catalog.installed[0]?.issues[0]).toContain('缺少声明的模板')
    expect(catalog.installed[0]?.profiles[0]?.availability).toMatchObject({ available: false })
    await expect(execute()).rejects.toThrow('包内模板不存在')
    expect(await app.core.vault.listFiles()).toHaveLength(1)
  })

  it('模板日期标题变量按一次替换，普通JSON与代码大括号原样保留', async () => {
    app = await testApp()
    await install()
    app.write('templates/自定义.md', '---\ntags: [虚构]\nplace: 书房\ncustom: 保留\n---\n# {{title}}\n日期：{{date}}\n```json\n{"year": "{{yyyy}}", "month": {{MM}}, "day": {{dd}}}\n```\n')
    await configure({ ...options, template: { kind: 'user', path: 'templates/自定义.md' } })
    const result = await execute()
    if (result.kind !== 'open-note') throw new Error('结果不符')
    const doc = await app.call('doc:get', { ref: { path: result.path } })
    expect(doc.classification).toMatchObject({ tags: ['虚构'], place: '书房' })
    expect(doc.properties?.custom).toBe('保留')
    expect(doc.body).toContain('"year": "2026"')
    expect(doc.body).not.toContain('{{')
  })

  it('跨月跨年读取新的本地日期，修改规则仅影响后续路径', async () => {
    app = await testApp()
    await install()
    await configure()
    const firstDate = new Date(2026, 11, 31, 23, 59), secondDate = new Date(2027, 0, 1)
    const clock = vi.spyOn(app.core, 'now').mockReturnValue(firstDate)
    const first = await execute()
    clock.mockReturnValue(secondDate)
    const second = await execute()
    expect(first).toMatchObject({ path: 'content/工作/工作日记/2026年-12月/2026-12-31 工作日记.md', created: true })
    expect(second).toMatchObject({ path: 'content/工作/工作日记/2027年-01月/2027-01-01 工作日记.md', created: true })
    await configure({ ...options, directory: 'content/工作/另一个日记目录/{{yyyy}}/{{MM}}' })
    const third = await execute()
    expect(third).toMatchObject({ path: 'content/工作/另一个日记目录/2027/01/2027-01-01 工作日记.md', created: true })
    expect(await app.core.vault.listFiles()).toHaveLength(3)
  })

  it.each(['missing', 'unknown-variable', 'invalid-yaml', 'invalid-utf8'])('创建前模板异常 %s 不写空笔记、不回退inbox', async failure => {
    app = await testApp()
    await install()
    app.write('templates/异常模板.md', '# 合法模板')
    await configure({ ...options, template: { kind: 'user', path: 'templates/异常模板.md' } })
    if (failure === 'missing') fs.unlinkSync(app.file('templates/异常模板.md'))
    else app.write('templates/异常模板.md', failure === 'unknown-variable' ? '{{unknown}}' : failure === 'invalid-yaml' ? '---\ntags: [\n---\n正文' : Buffer.from([0xff, 0xfe]))
    await expect(execute()).rejects.toThrow()
    expect(await app.core.vault.listFiles()).toEqual([])
    expect(fs.existsSync(app.file('content/工作/工作日记'))).toBe(false)
    expect(fs.readdirSync(app.file('inbox'))).toEqual([])
  })

  it('目录路径被普通文件占用或目标是目录时明确失败，不改原内容', async () => {
    app = await testApp()
    await install()
    await configure()
    const target = await app.call('extensions:previewDateNote', { directory: options.directory!, filename: options.filename })
    app.write('content/工作/工作日记', '目录位置被文件占用')
    await expect(execute()).rejects.toThrow('IO_ERROR')
    expect(fs.readFileSync(app.file('content/工作/工作日记'), 'utf8')).toBe('目录位置被文件占用')
    fs.unlinkSync(app.file('content/工作/工作日记'))
    fs.mkdirSync(app.file(target.path), { recursive: true })
    await expect(execute()).rejects.toThrow('CONFLICT')
    expect(fs.statSync(app.file(target.path)).isDirectory()).toBe(true)
  })

  it('目标附属属性冲突保留原属性并拒绝创建新文件', async () => {
    app = await testApp()
    await install()
    await configure()
    const target = await app.call('extensions:previewDateNote', { directory: options.directory!, filename: options.filename })
    app.write(target.path + '.meta.yaml', 'attachment: true\n')
    await expect(execute()).rejects.toThrow('CONFLICT')
    expect(fs.existsSync(app.file(target.path))).toBe(false)
    expect(fs.readFileSync(app.file(target.path + '.meta.yaml'), 'utf8')).toBe('attachment: true\n')
  })

  it('执行前目录被换成模板根链接时拒绝越界，副本目标链接同样受保护', async () => {
    app = await testApp()
    await install()
    await configure()
    fs.symlinkSync(app.file('templates'), app.file('content/工作/工作日记'), 'junction')
    await expect(execute()).rejects.toThrow('PATH_OUTSIDE_VAULT')
    fs.symlinkSync(app.file('content/工作'), app.file('templates/链接目录'), 'junction')
    await expect(app.call('extensions:copyTemplate', { id: 'work-diary', path: 'templates/default.md', targetPath: 'templates/链接目录/副本.md' })).rejects.toThrow('PATH_OUTSIDE_VAULT')
    expect(fs.existsSync(app.file('content/工作/副本.md'))).toBe(false)
    expect(fs.existsSync(app.file('templates/2026年-11月'))).toBe(false)
  })

  it('模板读取后外部创建同名文件，排他创建保留外部文件', async () => {
    app = await testApp()
    await install()
    await configure()
    const target = await app.call('extensions:previewDateNote', { directory: options.directory!, filename: options.filename })
    const open = fs.promises.open.bind(fs.promises)
    let raced = false
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (!raced && String(file) === app!.file(target.path) && flags === 'wx') {
        raced = true
        fs.writeFileSync(String(file), '外部刚创建的正文')
      }
      return open(file, flags, mode)
    })
    expect(await execute()).toEqual({ kind: 'open-note', path: target.path, created: false })
    expect(fs.readFileSync(app.file(target.path), 'utf8')).toBe('外部刚创建的正文')
    expect(raced).toBe(true)
  })

  it('不可写的目标返回实际错误，不产生别名笔记或落到其他目录', async () => {
    app = await testApp()
    await install()
    await configure()
    const target = await app.call('extensions:previewDateNote', { directory: options.directory!, filename: options.filename })
    const open = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file) === app!.file(target.path) && flags === 'wx') throw Object.assign(new Error('虚构不可写'), { code: 'EACCES' })
      return open(file, flags, mode)
    })
    await expect(execute()).rejects.toThrow('IO_ERROR')
    expect(await app.core.vault.listFiles()).toEqual([])
  })

  it('操作已经开始时固定原配置；停用影响后续触发，当前操作完成', async () => {
    app = await testApp()
    await install()
    await configure()
    const read = app.core.templates.read.bind(app.core.templates)
    const entered = deferred(), resume = deferred()
    vi.spyOn(app.core.templates, 'read').mockImplementation(async (...args) => { entered.release(); await resume.promise; return read(...args) })
    const writing = execute()
    await entered.promise
    const disabling = app.call('extensions:setEnabled', { id: 'work-diary', enabled: false })
    resume.release()
    expect(await writing).toMatchObject({ created: true })
    await disabling
    await expect(execute()).rejects.toThrow('NOT_FOUND')
    expect(await app.core.vault.listFiles()).toHaveLength(1)
  })

  it('还在队列等待的日记命令遇到切库取消，不写进新库', async () => {
    app = await testApp()
    await install()
    await configure()
    const entered = deferred(), resume = deferred()
    const blocker = app.core.mutate(async () => { entered.release(); await resume.promise })
    await entered.promise
    const writing = execute()
    const rejected = expect(writing).rejects.toThrow('笔记库已切换')
    const switching = app.call('vault:open', { path: path.join(app.tmp.dir, 'next-vault'), create: true })
    resume.release()
    await blocker
    await rejected
    await switching
    await app.core.jobs.stop()
    expect(await app.core.vault.listFiles()).toEqual([])
    expect(fs.existsSync(app.file('content/工作/工作日记'))).toBe(false)
  })

  it('重启或删除索引后已有日记仍直接打开；卸载不删除笔记和用户模板', async () => {
    app = await testApp()
    await install()
    await configure()
    const first = await execute()
    await app.reopen({ removeIndex: true })
    expect(await execute()).toEqual({ ...first, created: false })
    app.write('templates/用户模板.md', '# 用户资源')
    await app.call('extensions:uninstall', { id: 'work-diary', confirmed: true })
    if (first.kind !== 'open-note') throw new Error('结果不符')
    expect(fs.existsSync(app.file(first.path))).toBe(true)
    expect(fs.readFileSync(app.file('templates/用户模板.md'), 'utf8')).toBe('# 用户资源')
    expect((await app.call('library:query', {})).total).toBe(1)
  })

  it('模板副本保留原始变量与字节，普通编辑生效且不受插件卸载影响', async () => {
    app = await testApp()
    await install()
    const template = await app.call('extensions:readTemplate', { id: 'work-diary', template: { kind: 'package', path: 'templates/default.md' } })
    const targetPath = 'templates/工作/自定义日记.md'
    expect(await app.call('extensions:copyTemplate', { id: 'work-diary', path: 'templates/default.md', targetPath })).toEqual({ path: targetPath })
    expect(fs.readFileSync(app.file(targetPath), 'utf8')).toBe(template)
    await expect(app.call('extensions:copyTemplate', { id: 'work-diary', path: 'templates/default.md', targetPath })).rejects.toThrow('CONFLICT')
    const doc = await app.call('doc:get', { ref: { path: targetPath } })
    await app.call('doc:saveBody', { ref: { path: targetPath }, body: '# {{title}}\n我的用户模板', baseHash: doc.hash })
    expect(await app.call('extensions:readTemplate', { id: 'work-diary', template: { kind: 'user', path: targetPath } })).toContain('我的用户模板')
    await app.call('extensions:uninstall', { id: 'work-diary', confirmed: true })
    expect(fs.readFileSync(app.file(targetPath), 'utf8')).toContain('我的用户模板')
    expect(app.core.index.getDoc(targetPath)).toBeNull()
    for (const targetPath of ['content/不该写的.md', '../模板.md', '.jot/秘密.md']) {
      expect(argSchemas['extensions:copyTemplate'].safeParse({ id: 'work-diary', path: 'templates/default.md', targetPath }).success).toBe(false)
    }
  })
})

describe('模板变量', () => {
  it('只替换声明的变量，不求值脚本或兼容其他模版语法', () => {
    const values = { date: '2026-11-23', title: '示例标题' }
    expect(expandNoteTemplate('{{title}} {{date}} {{yyyy}}/{{MM}}/{{dd}}', values)).toBe('示例标题 2026-11-23 2026/11/23')
    expect(expandNoteTemplate('{"key": "value"}\n${dangerous()}\n', values)).toBe('{"key": "value"}\n${dangerous()}\n')
    for (const template of ['{{unknown}}', '{{yyyy', '{{ date }}', '{{process.env.SECRET}}']) expect(() => expandNoteTemplate(template, values)).toThrow()
  })
})
