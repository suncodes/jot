import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/types'
import { createWorkReportOptions, planWorkReport, type WorkReportPaths, type WorkReportPlan, type WorkReportProfiles, type WorkReportSource } from '@shared/work-reports'
import { AgentFiles } from '../../electron/agent/files'
import { operationHelp, runOperation, type OperationContext } from '../../electron/agent/operations'
import { agentScript, isAgentRequest } from '../helpers/fake-llm'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
let context: OperationContext
let events: AgentEvent[]
let usesModel: boolean
const paths = (patch: Partial<WorkReportPaths> = {}): WorkReportPaths => ({
  root: 'content/研发/工作', draftDirectory: '草稿/{{yyyy}}年/{{MM}}月', reportDirectory: '正式/{{yyyy}}-{{MM}}',
  worklogDirectory: 'content/工程日志', filename: '{{dd}}日.md', ...patch,
})
const profileSource: WorkReportSource = { kind: 'profile', extensionId: 'work-diary', profileId: 'today' }
const explicit = (patch: Partial<WorkReportPaths> = {}): WorkReportSource => ({ kind: 'paths', paths: paths(patch) })
const invoke = <T = unknown>(operation: string, args: object = {}) => runOperation(operation, args, context) as Promise<T>
async function install(ai = false) {
  fs.cpSync(path.resolve(import.meta.dirname, '../../resources/app-extensions/work-diary'), path.join(app.appExtensionCandidates, 'work-diary'), { recursive: true })
  const preview = await app.call('extensions:previewImport', { source: { kind: 'bundled', id: 'work-diary' } })
  await app.call('extensions:confirmImport', { token: preview!.token, installAiPlugin: ai })
  if (ai) await app.call('capabilities:setPluginEnabled', { id: 'work-report', enabled: true })
}
async function configure(id = 'today', options = paths()) {
  return app.call('extensions:saveProfile', { id: 'work-diary',
    profile: { ...(id === 'today' ? { id } : {}), commandId: 'today', name: id === 'today' ? '研发工作' : '其他工作',
      options: { ...createWorkReportOptions(), ...options } } })
}
beforeEach(async () => {
  events = []; usesModel = false
  app = await testApp((event, data) => { if (event === 'agent:event') events.push(structuredClone(data as AgentEvent)) })
  app.clock('2026-11-24T12:00:00+08:00')
  const files = new AgentFiles({ vault: app.core.vault, index: app.core.index, operations: () => app.core.operations,
    mutate: run => app.core.mutate(run), changed: () => app.core.idle(), moved: paths => app.core.agent.moveReferences(paths), trashed: () => {} })
  context = { app: app.core.operations, files, scope: {}, conversationId: app.core.agent.create().conversationId, confirm: vi.fn(async () => false) }
})
afterEach(async () => {
  vi.restoreAllMocks()
  try { if (!usesModel) expect(app.fake.requests).toHaveLength(0) }
  finally { await app.close() }
})

describe('W4 工作报告配置与材料计划', () => {
  it('未安装时公开查询为空且不产生配置或内容；不能省略来源自动选入口', async () => {
    expect(await invoke('work_reports.profiles')).toEqual({ profiles: [], issues: [] })
    expect(fs.existsSync(app.file('.jot/app-extensions.json'))).toBe(false)
    expect(await app.core.vault.listFiles()).toEqual([])
    await expect(invoke('work_reports.prepare', { request: { kind: 'daily' } })).rejects.toThrow('source')
    await expect(invoke('work_reports.prepare', { source: profileSource, request: { kind: 'daily' } })).rejects.toThrow('入口不存在')
  })

  it('公开路径读取唯一配置，停用可用，不读取模板／AI包或重注册命令', async () => {
    await install(); await configure()
    const reload = vi.spyOn(app.core.extensions, 'reload')
    const templates = vi.spyOn(app.core.templates, 'read')
    const aiCatalog = vi.spyOn(app.core.capabilities, 'catalog')
    const result = await invoke<WorkReportProfiles>('work_reports.profiles')
    expect(result).toEqual({ profiles: [{ extensionId: 'work-diary', profileId: 'today', name: '研发工作', enabled: false, paths: paths() }], issues: [] })
    expect(JSON.stringify(result)).not.toMatch(/template|apiKey/)
    expect(reload).not.toHaveBeenCalled(); expect(templates).not.toHaveBeenCalled(); expect(aiCatalog).not.toHaveBeenCalled()
    const prepared = await invoke<WorkReportPlan>('work_reports.prepare', { source: profileSource, request: { kind: 'daily' } })
    expect(prepared.days[0]!.draftPath).toBe('content/研发/工作/草稿/2026年/11月/2、日报/24日.md')
    expect(prepared.request).toEqual({ kind: 'daily', date: '2026-11-24' })
    expect(fs.existsSync(app.file(paths().root!))).toBe(false)
  })

  it('多入口明确选择，实时读取外部配置变动，个人日记不冒充工作配置', async () => {
    await install(); await configure(); const other = await configure('other', paths({ root: 'content/另一个工作' }))
    let result = await invoke<WorkReportProfiles>('work_reports.profiles')
    expect(result.profiles).toHaveLength(2)
    expect((await invoke<WorkReportPlan>('work_reports.prepare', { source: { ...profileSource, profileId: other.id }, request: { kind: 'daily' } })).path).toMatch(/^content\/另一个工作\//)
    const config = await app.core.extensionState.getConfiguration()
    config.extensions['work-diary']!.profiles[0]!.options = { ...createWorkReportOptions(), ...paths({ root: 'content/外部修改' }) }
    app.write('.jot/app-extensions.json', JSON.stringify(config))
    result = await invoke<WorkReportProfiles>('work_reports.profiles')
    expect(result.profiles[0]!.paths.root).toBe('content/外部修改')
    const manifestPath = '.jot/app-extensions/work-diary/extension.json'
    const manifest = JSON.parse(fs.readFileSync(app.file(manifestPath), 'utf8'))
    manifest.commands = [{ ...manifest.commands[0], action: 'daily-note', defaults: { directory: null, filename: '{{dd}}.md', template: { kind: 'none' } } }]
    app.write(manifestPath, JSON.stringify(manifest))
    const mismatched = await invoke<WorkReportProfiles>('work_reports.profiles')
    expect(mismatched.profiles).toEqual([])
    expect(mismatched.issues[0]!.message).toContain('选项与清单动作不匹配')
  })

  it('未配置根目录明确报错；损坏配置和清单不能伪装成无配置', async () => {
    await install()
    expect((await invoke<WorkReportProfiles>('work_reports.profiles')).profiles[0]!.paths.root).toBeNull()
    await expect(invoke('work_reports.prepare', { source: profileSource, request: { kind: 'daily' } })).rejects.toThrow('工作根目录')
    await configure()
    app.write('.jot/app-extensions/work-diary/extension.json', '{}')
    const result = await invoke<WorkReportProfiles>('work_reports.profiles')
    expect(result.profiles).toEqual([]); expect(result.issues).toHaveLength(1)
    await expect(invoke('work_reports.prepare', { source: profileSource, request: { kind: 'daily' } })).rejects.toThrow('不可用')
    app.write('.jot/app-extensions.json', '{"broken":true}')
    await expect(invoke('work_reports.profiles')).rejects.toThrow('配置格式无效')
  })

  it('跨年周报定位两月草稿及OKR，唯一目标在结束月，无文件操作', async () => {
    const result = await invoke<WorkReportPlan>('work_reports.prepare', { source: explicit(), request: { kind: 'weekly', date: '2025-12-31' } })
    expect(result).toMatchObject({ from: '2025-12-29', to: '2026-01-02', path: 'content/研发/工作/正式/2026-01/3、周报/2025-12-29~2026-01-02.md', worklogDirectory: 'content/工程日志' })
    expect(result.days.map(day => day.date)).toEqual(['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'])
    expect(result.days.at(-1)!.draftPath).toBe('content/研发/工作/草稿/2026年/01月/2、日报/02日.md')
    expect(result.months.map(month => month.month)).toEqual(['2025-12', '2026-01'])
    expect(result.months[1]!.draftOkrPath).toContain('2026年/01月/1、OKR/2026年01月OKR.md')
    expect(await app.core.vault.listFiles()).toEqual([])
  })

  it('月报包含相交的跨月周报，排除不相交的上月工作周；路径及日期统一校验', async () => {
    app.clock('2026-12-15T12:00:00+08:00')
    const result = await invoke<WorkReportPlan>('work_reports.prepare', { source: explicit(), request: { kind: 'monthly', date: '2026-11-03' } })
    expect(result.days).toHaveLength(30)
    expect(result.weekly.at(-1)).toMatchObject({ from: '2026-11-30', to: '2026-12-04', path: expect.stringContaining('正式/2026-12/') })
    expect(result.weekly.some(week => week.to < result.from)).toBe(false)
    for (const invalid of [
      { source: explicit({ root: '../outside' }), request: { kind: 'daily' } },
      { source: explicit({ reportDirectory: '草稿/{{yyyy}}年/{{MM}}月' }), request: { kind: 'daily' } },
      { source: explicit(), request: { kind: 'daily', date: '2026-02-30' } },
      { source: explicit(), request: { kind: 'unknown' } },
      { source: explicit(), request: { kind: 'daily' }, path: 'content/任意.md' },
    ]) await expect(invoke('work_reports.prepare', invalid)).rejects.toThrow()
    expect(operationHelp('work_reports')).toHaveLength(3)
  })
})

describe('W4 正式报告保存边界', () => {
  it.each(['daily', 'weekly', 'monthly', 'okr'] as const)('%s只覆盖计算出的正式目标，保留属性与草稿，不触发普通覆盖确认', async kind => {
    const source = explicit({ root: 'content/工作(研发)#资料' })
    const target = await invoke<WorkReportPlan>('work_reports.prepare', { source, request: { kind } })
    const draft = target.days[0]!.draftPath
    app.write(draft, '用户草稿，不可改写')
    app.write(target.months[0]!.draftOkrPath, '原始目标，不可改写')
    app.write(target.path, '---\ntags: [工作]\ncustom: 人工属性\n---\n旧正式正文')
    const result = await invoke<{ path: string; updated: string[]; failed: unknown[]; link: string }>('work_reports.write', { source, request: target.request, body: '# 正式报告\n\n有依据的进展。' })
    expect(result).toMatchObject({ path: target.path, updated: [target.path], failed: [] })
    expect(result.link).toContain('%28'); expect(result.link).toContain('%29'); expect(result.link).toContain('%23'); expect(result.link).toContain(encodeURIComponent('资料'))
    expect((await app.core.vault.read({ path: target.path })).body).toBe('# 正式报告\n\n有依据的进展。')
    expect(fs.readFileSync(app.file(target.path), 'utf8')).toContain('custom: 人工属性')
    expect(fs.readFileSync(app.file(draft), 'utf8')).toBe('用户草稿，不可改写')
    expect(fs.readFileSync(app.file(target.months[0]!.draftOkrPath), 'utf8')).toBe('原始目标，不可改写')
    expect(context.confirm).not.toHaveBeenCalled()
    expect(app.core.index.getDoc(target.path)).toBeTruthy()
  })

  it('无应用插件可按明确路径创建报告；未配置工程日志不猜全库，旧路径不使用', async () => {
    const source = explicit({ worklogDirectory: null })
    const target = await invoke<WorkReportPlan>('work_reports.prepare', { source, request: { kind: 'daily' } })
    const result = await invoke('work_reports.write', { source, request: target.request, body: '独立技能的报告' })
    expect(result).toMatchObject({ updated: [target.path], failed: [] })
    expect(target.worklogDirectory).toBeNull()
    expect(fs.existsSync(app.file('.jot/app-extensions.json'))).toBe(false)
    expect(fs.existsSync(app.file(target.days[0]!.draftPath))).toBe(false)
    expect(fs.existsSync(app.file(target.months[0]!.draftOkrPath))).toBe(false)
  })

  it('普通文件覆盖仍须确认，不能以path、额外参数或未知入口绕过', async () => {
    app.write('content/普通.md', '用户正文')
    await expect(context.files.write([{ path: 'content/普通.md', body: '不该写' }], context.confirm)).rejects.toThrow('未同意覆盖')
    expect(context.confirm).toHaveBeenCalledOnce()
    for (const extra of [{ path: 'content/普通.md' }, { skipConfirm: true }, { overwrite: true }]) {
      await expect(invoke('work_reports.write', { source: explicit(), request: { kind: 'daily' }, body: '报告', ...extra })).rejects.toThrow('Unrecognized')
    }
    await expect(invoke('work_reports.write', { source: profileSource, request: { kind: 'daily' }, body: '报告' })).rejects.toThrow('入口不存在')
    expect(fs.readFileSync(app.file('content/普通.md'), 'utf8')).toBe('用户正文')
  })

  it('读取范围不被材料计划扩大；明确的报告输出可在另一个库内目录', async () => {
    const source = explicit()
    const plan = await invoke<WorkReportPlan>('work_reports.prepare', { source, request: { kind: 'daily' } })
    const material = plan.days[0]!.draftPath
    app.write(material, '范围内草稿'); app.write('content/机密.md', '范围外不可读取')
    context.scope = { materials: [{ kind: 'file', value: material }] }
    expect((await context.files.read(material, context.scope)).body).toBe('范围内草稿')
    await expect(context.files.read('content/机密.md', context.scope)).rejects.toThrow('限定材料')
    await expect(context.files.find({ directory: 'content' }, context.scope)).resolves.toMatchObject({ items: [{ path: material }] })
    expect(await invoke('work_reports.write', { source, request: plan.request, body: '仅根据指定草稿' })).toMatchObject({ updated: [plan.path], failed: [] })
  })

  it('实际写入失败没有成功链接，不改旧正文；停止后不继续保存', async () => {
    const source = explicit(), request = { kind: 'daily' }
    const plan = await invoke<WorkReportPlan>('work_reports.prepare', { source, request })
    app.write(plan.path, '需要保留的旧正式正文')
    vi.spyOn(app.core.vault, 'saveCurrentBody').mockRejectedValue(new Error('虚构文件占用'))
    const result = await invoke('work_reports.write', { source, request, body: '替换失败' })
    expect(result).toEqual({ path: plan.path, updated: [], failed: [{ path: plan.path, message: '虚构文件占用' }] })
    expect(fs.readFileSync(app.file(plan.path), 'utf8')).toBe('需要保留的旧正式正文')
    const controller = new AbortController(); controller.abort(); context.signal = controller.signal
    await expect(invoke('work_reports.write', { source, request, body: '不应执行' })).rejects.toThrow('已停止')
  })

  it('停止发生在配置计算之后，也不会把报告落盘', async () => {
    const controller = new AbortController(), service = app.core.workReports
    const prepare = service.prepare.bind(service)
    vi.spyOn(service, 'prepare').mockImplementation(async (source, request) => { const plan = await prepare(source, request); controller.abort(); return plan })
    context.signal = controller.signal
    await expect(invoke('work_reports.write', { source: explicit(), request: { kind: 'daily' }, body: '不应执行' })).rejects.toThrow('已停止')
    expect(await app.core.vault.listFiles()).toEqual([])
  })
})

describe('W4 通用助手实际工具流程', () => {
  it.each(['daily', 'weekly', 'monthly', 'okr'] as const)('%s加载规则、读取当前材料并直接保存，严格范围不阻止明确报告输出', async kind => {
    await install(true); await configure()
    usesModel = true
    await app.core.settings.set({ model: { contextWindow: 65536 } })
    const plan = planWorkReport(paths(), { kind }, app.core.now())
    const material = kind === 'daily' ? plan.days.at(-1)!.draftPath : plan.days[0]!.reportPath
    app.write(material, '---\ntags: [工作]\n---\n已完成接口静态检查，尚未联调。\n' + '过程事实。'.repeat(1300) + '\n最后事实：等待真实联调。')
    app.write(plan.path, '---\ncustom: 保留\n---\n原正式报告')
    const body = '# 正式工作报告\n\n已完成静态检查，真实联调待进行。\n\n[材料](' + path.posix.relative(path.posix.dirname(plan.path), material).split('/').map(encodeURIComponent).join('/') + ')'
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-report:work-report', path: 'references/' + kind + '.md' } } }),
      () => ({ toolCall: { name: 'app_help', arguments: { name: 'work_reports.write' } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.profiles', args: {} } } }),
      results => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.prepare', args: {
        source: { kind: 'profile', extensionId: JSON.parse(results[2]!).profiles[0].extensionId, profileId: JSON.parse(results[2]!).profiles[0].profileId }, request: { kind },
      } } } }),
      () => ({ toolCall: { name: 'find_files', arguments: { directory: path.posix.dirname(material), pattern: '*.md' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: material } } }),
      results => ({ toolCall: { name: 'read', arguments: JSON.parse(results[5]!.match(/nextRead: (.+)$/)![1]!) } }),
      results => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.write', args: { source: profileSource, request: JSON.parse(results[3]!).request, body } } } }),
      results => '已保存 ' + JSON.parse(results[7]!).link + '。尚缺真实联调结果。',
    ]))
    const id = app.core.agent.create().conversationId
    const { runId } = await app.call('agent:send', { conversationId: id, text: '$work-report:work-report 生成并保存' + kind,
      context: { agentId: 'default', skillIds: ['work-report:work-report'], strict: true, references: [{ kind: 'file', value: material, title: '指定材料' }] } })
    await app.core.agent.wait(runId)
    const reply = (await app.call('agent:get', { conversationId: id })).messages.at(-1)!
    expect(reply.error).toBeUndefined()
    expect(reply.toolCalls).toHaveLength(8)
    expect(reply.toolCalls?.every(call => call.ok)).toBe(true)
    expect(reply.toolCalls![6]!.output).toContain('最后事实')
    expect(reply.text).toContain('已保存')
    expect(reply.text).toContain(encodeURIComponent('正式'))
    expect(events.some(event => event.type === 'tool-update' && event.call.confirmation)).toBe(false)
    expect((await app.core.vault.read({ path: plan.path })).body).toBe(body)
    expect(fs.readFileSync(app.file(plan.path), 'utf8')).toContain('custom: 保留')
    expect(app.fake.requests.filter(isAgentRequest).length).toBeGreaterThan(1)
    expect((await app.call('extensions:configuration', undefined)).extensions['work-diary']!.enabled).toBe(false)
  })
})

describe('正式报告回读核验', () => {
  it('写入后被外部修改不返回成功链接，保留实际文件供用户处理', async () => {
    const source = explicit(), request = { kind: 'daily' as const }, plan = await app.core.workReports.prepare(source, request)
    app.write(plan.path, '---\ncustom: 保留\n---\n原正式正文')
    const save = app.core.vault.saveCurrentBody.bind(app.core.vault)
    vi.spyOn(app.core.vault, 'saveCurrentBody').mockImplementation(async (rel, body, expected) => {
      const result = await save(rel, body, expected)
      app.write(rel, '---\ncustom: 保留\n---\n外部修改后的正文')
      return result
    })
    const result = await invoke<{ updated: string[]; failed: { message: string }[]; link?: string }>('work_reports.write', { source, request, body: '计划保存的正文' })
    expect(result.updated).toEqual([])
    expect(result.failed[0]?.message).toContain('回读正文与本次提交不一致')
    expect(result.link).toBeUndefined()
    expect(fs.readFileSync(app.file(plan.path), 'utf8')).toContain('外部修改后的正文')
    expect(context.confirm).not.toHaveBeenCalled()
  })
})

describe('工作总结的完成前核对流程', () => {
  it('按日报规则加载资源，保存后回读发现遗漏，定向修正后再次读取并返回最终链接', async () => {
    await install(true); await configure()
    usesModel = true
    const request = { kind: 'daily' as const }, plan = await app.core.workReports.prepare(profileSource, request)
    const material = plan.days[0]!.draftPath
    app.write(material, '已完成接口静态检查，尚未真实联调；明日安排真实联调。原始计划和OKR目标未提供。')
    const incomplete = '# 工作日报\n\n## 今日进展\n完成接口静态检查，真实联调尚未进行。'
    const final = '# 工作日报\n\n## 今日计划\n未提供明确的原始计划。\n\n## 今日进展\n完成接口静态检查，真实联调尚未进行。\n\n## 明日计划\n按记录安排真实联调。\n\n## 今日 OKR 总结\n未提供当月目标，暂不归因到具体O/K。'
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-report:work-report', path: 'references/daily.md' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: material } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.write', args: { source: profileSource, request: plan.request, body: incomplete } } } }),
      results => ({ toolCall: { name: 'read', arguments: { path: JSON.parse(results[2]!).path } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'work_reports.write', args: { source: profileSource, request: plan.request, body: final } } } }),
      results => ({ toolCall: { name: 'read', arguments: { path: JSON.parse(results[4]!).path } } }),
      results => '已核对并保存 ' + JSON.parse(results[4]!).link + '。原始计划与OKR目标仍缺失。',
    ]))
    const id = app.core.agent.create().conversationId
    const { runId } = await app.call('agent:send', { conversationId: id, text: '$work-report:work-report 按今天草稿生成日报，并核对要求',
      context: { agentId: 'default', skillIds: ['work-report:work-report'], strict: false, references: [{ kind: 'file', value: material, title: '草稿' }] } })
    await app.core.agent.wait(runId)
    const result = app.core.agent.get(id).messages.at(-1)!
    expect(result.error).toBeUndefined()
    expect(result.toolCalls?.every(call => call.ok)).toBe(true)
    expect(result.toolCalls?.map(call => call.name)).toEqual(['use_skill', 'read', 'app_manage', 'read', 'app_manage', 'read'])
    expect(result.toolCalls![3]!.output).not.toContain('## 明日计划')
    expect(result.toolCalls![5]!.output).toContain('## 明日计划')
    expect(result.toolCalls![5]!.output).toContain('暂不归因到具体O/K')
    expect((await app.core.vault.read({ path: plan.path })).body).toBe(final)
    expect(fs.readFileSync(app.file(material), 'utf8')).toContain('原始计划和OKR目标未提供')
    expect(result.text).toContain('仍缺失')
    expect(events.some(event => event.type === 'tool-update' && event.call.confirmation)).toBe(false)
  })
})
