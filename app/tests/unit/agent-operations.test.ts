import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, DocMeta, InboxItem, JobInfo, Paged, TermInfo, TrashItem } from '@shared/types'
import { AgentFiles } from '../../electron/agent/files'
import { APP_ACTIONS, operationHelp, runOperation, type OperationContext } from '../../electron/agent/operations'
import { agentScript, isAgentRequest } from '../helpers/fake-llm'
import { deferred, testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
let context: OperationContext
let events: AgentEvent[]
const call = <T = unknown>(operation: string, args: object = {}) => runOperation(operation, args, context) as Promise<T>
beforeEach(async () => {
  events = []
  app = await testApp((name, data) => { if (name === 'agent:event') events.push(structuredClone(data as AgentEvent)) })
  const files = new AgentFiles({ vault: app.core.vault, index: app.core.index, operations: () => app.core.operations,
    mutate: operation => app.core.mutate(operation), changed: () => app.core.idle(), moved: paths => app.core.agent.moveReferences(paths), trashed: () => {} })
  context = { app: app.core.operations, files, scope: {}, conversationId: app.core.agent.create().conversationId, confirm: async () => true }
})
afterEach(async () => { vi.restoreAllMocks(); await app.close() })

describe('U2 软件操作', () => {
  it('所有操作提供严格参数及示例；不允许任意IPC或额外模型密钥字段', async () => {
    expect(operationHelp()).toHaveLength(12)
    expect(new Set(APP_ACTIONS.map(action => action.name)).size).toBe(APP_ACTIONS.length)
    for (const action of APP_ACTIONS) {
      expect(action.schema.safeParse(action.example).success, action.name).toBe(true)
      const detail = operationHelp(undefined, action.name)[0] as { parameters: object; example: { operation: string; args: unknown } }
      expect(JSON.stringify(detail.parameters)).toMatch(/type|oneOf/)
      expect(detail.example.operation).toBe(action.name)
      expect(action.schema.safeParse(detail.example.args).success, action.name).toBe(true)
      expect(action.schema.safeParse({ ...action.example, unsupported: true }).success).toBe(false)
    }
    await expect(call('settings:set', {})).rejects.toThrow('未知操作')
    await expect(call('settings.set', { model: { apiKey: 'secret' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(call<JobInfo & { status: string }>('daily.generate', { date: '2026-02-30' })).rejects.toThrow('日期')
    await expect(call<DocMeta>('pending.accept', { path: 'x', kind: 'all' })).rejects.toThrow()
    expect(app.fake.requests).toHaveLength(0)
  })

  it('灵感、补记、普通笔记沿用真实落点及捕获逻辑；日期区间可修改，重启保留', async () => {
    const idea = await call<DocMeta>('records.idea', { text: '设计新想法 #灵感' })
    const log = await call<DocMeta>('records.log', { text: '完成例会记录', start: '2026-11-18', end: '2026-11-19' })
    const note = await call<DocMeta>('records.note', { title: '待归档规则', body: '业务事实' })
    expect(idea.path).toMatch(/^ideas\/2026\/11\//)
    expect(log.path).toMatch(/^ideas\/2026\/11\//)
    expect(note.path).toBe('inbox/2026/11/待归档规则.md')
    expect((await call<Paged<TermInfo>>('terms.list', { kind: 'tag' })).items).toContainEqual(expect.objectContaining({ name: '灵感' }))
    await call('records.time', { mode: 'date', path: idea.path, occurredAt: '2026-11-17' })
    await call('records.time', { mode: 'range', path: log.path, start: '2026-11-17', end: '2026-11-18' })
    await app.reopen({ removeIndex: true })
    expect((await app.call('doc:get', { ref: { path: idea.path } })).occurredAt).toBe('2026-11-17')
    expect((await app.call('doc:get', { ref: { path: log.path } })).start).toBe('2026-11-17')
    expect((await app.call('classify:inbox', {})).items.map(item => item.doc.path)).toEqual([note.path])
    expect(app.fake.requests).toHaveLength(0)
  })

  it('直接匹配和原文搜索读取未索引文件，按实际行号分页，严格范围不泄漏', async () => {
    app.write('content/工作/直接查找/甲.md', '---\ntags: [核对]\n---\n唯一目标一\n普通行\n唯一目标二')
    app.write('content/工作/直接查找/乙.txt', '唯一目标三')
    app.write('content/生活/范围外.md', '唯一目标四')
    app.write('content/工作/直接查找/二进制.txt', Buffer.from([65, 0, 66]))
    await app.core.idle()
    app.core.index.remove('content/工作/直接查找/甲.md')
    const first = await context.files.find({ directory: 'content/工作/直接查找', pattern: '*.md', query: '唯一目标', limit: 1 }, {})
    expect(first).toMatchObject({ total: 2, nextOffset: 1, complete: true, items: [{ path: 'content/工作/直接查找/甲.md', line: 4, text: '唯一目标一' }] })
    const second = await context.files.find({ directory: 'content/工作/直接查找', query: '唯一目标', limit: 1, offset: 1 }, {})
    expect(second.items[0]).toMatchObject({ line: 6, text: '唯一目标二' })
    const scope = { materials: [{ kind: 'folder' as const, value: 'content/工作/直接查找' }] }
    const found = await context.files.find({ pattern: '**/*.md' }, scope)
    expect(found.items.map(item => item.path)).toEqual(['content/工作/直接查找/甲.md'])
    expect((await context.files.find({ query: '唯一目标' }, scope)).total).toBe(3)
    const aborted = new AbortController(); aborted.abort()
    await expect(context.files.find({}, {}, aborted.signal)).rejects.toThrow('已停止')
  })

  it('预置及词条全局改名合并沿用属性服务；全局解除必须确认且报告部分失败', async () => {
    app.write('content/工作/甲.md', '---\ntags: [旧名, 合并名]\npeople: [张工]\nplace: 一楼\n---\n原正文')
    app.write('content/工作/乙.md', '---\ntags: [旧名/子标签]\n---\n乙正文')
    await app.core.syncIndex()
    await call('terms.create', { kind: 'tag', name: '预置零次数' })
    expect((await call<Paged<TermInfo>>('terms.list', { kind: 'tag' })).items).toContainEqual(expect.objectContaining({ name: '预置零次数', count: 0 }))
    await call('terms.rename', { kind: 'tag', from: '旧名', to: '新名' })
    await call('terms.merge', { kind: 'tag', from: ['新名', '合并名'], into: '统一' })
    const confirm = vi.fn(async (_title: string, _targets: Parameters<OperationContext['confirm']>[1]) => false); context.confirm = confirm
    await expect(call('terms.remove', { kind: 'tag', name: '统一' })).rejects.toThrow('取消')
    expect(confirm.mock.calls[0]![1].map((target: { path: string }) => target.path)).toContain('content/工作/甲.md')
    expect((await app.core.vault.read({ path: 'content/工作/甲.md' })).classification.tags).toEqual(['统一'])
    context.confirm = async () => true
    const original = app.core.vault.patchFrontmatter.bind(app.core.vault)
    vi.spyOn(app.core.vault, 'patchFrontmatter').mockImplementation((ref, patch, who) => {
      if (ref.path.endsWith('乙.md')) throw new Error('虚构写入失败')
      return original(ref, patch, who)
    })
    const result = await call('terms.remove', { kind: 'tag', name: '统一' })
    expect(result).toMatchObject({ affected: 1, failed: [{ path: 'content/工作/乙.md', message: '虚构写入失败' }] })
    expect(fs.readFileSync(app.file('content/工作/甲.md'), 'utf8')).toContain('原正文')
  })

  it('待处理目录和属性分别确认；手动归档不请求模型，忽略属性不强制归档灵感', async () => {
    const note = await call<DocMeta>('records.note', { title: '待处理', body: '待归档事实' })
    const idea = await call<DocMeta>('records.idea', { text: '长期保留想法' })
    app.core.state.setSuggestion(note.path, { kind: 'properties', properties: { tags: ['业务'] }, confidence: 0.8, reason: '相关' })
    app.core.state.setSuggestion(note.path, { kind: 'directory', directoryPath: 'content/工作', confidence: 0.8, reason: '相关' })
    expect((await call<Paged<InboxItem>>('pending.list')).items).toHaveLength(1)
    await call<DocMeta>('pending.accept', { path: note.path, kind: 'properties' })
    const moved = await call<DocMeta>('pending.accept', { path: note.path, kind: 'directory' })
    expect(moved.path).toBe('content/工作/待处理.md')
    expect((await call<Paged<InboxItem>>('pending.list')).total).toBe(0)
    app.core.state.setSuggestion(idea.path, { kind: 'properties', properties: { tags: ['灵感'] }, confidence: 0.4, reason: '待确认' })
    await call('pending.skip', { path: idea.path, kind: 'properties' })
    expect((await call<Paged<InboxItem>>('pending.list')).total).toBe(0)
    expect(fs.existsSync(app.file(idea.path))).toBe(true)
    expect(app.fake.requests).toHaveLength(0)
  })

  it('回收目录或文件可恢复并另存冲突；永久清理只处理确认编号，取消保持原件', async () => {
    await context.files.mkdir('content/工作', '待回收')
    app.write('content/工作/待回收/原件.txt', '原件')
    app.write('content/工作/待回收/原件.txt.meta.yaml', 'tags: [原属性]')
    await app.core.idle()
    const recycled = await context.files.trash(['content/工作/待回收'], async () => true)
    expect((await call<Paged<TrashItem>>('trash.list')).items[0]!.trashId).toBe(recycled[0]!.trashId)
    await context.files.mkdir('content/工作', '待回收')
    const restored = await call<{ results: { result: { path: string } }[] }>('trash.restore', { ids: [recycled[0]!.trashId] })
    expect(restored.results[0]!.result.path).toBe('content/工作/待回收 2')
    expect(fs.existsSync(app.file('content/工作/待回收 2/原件.txt.meta.yaml'))).toBe(true)
    const trash = await context.files.trash(['content/工作/待回收 2/原件.txt'], async () => true)
    context.confirm = async () => false
    await expect(call('trash.purge', { ids: [trash[0]!.trashId] })).rejects.toThrow('取消')
    expect((await call<Paged<TrashItem>>('trash.list')).total).toBe(1)
    context.confirm = async () => true
    await call('trash.purge', { ids: [trash[0]!.trashId] })
    expect((await call<Paged<TrashItem>>('trash.list')).total).toBe(0)
  })

  it('后台操作返回真实去重编号；状态、取消、重试不伪造完成', async () => {
    const note = await call<DocMeta>('records.note', { title: '排队分析', body: '待分析内容' })
    const a = await call<JobInfo & { status: string }>('pending.analyze', { path: note.path })
    expect(a).toMatchObject({ state: 'queued', status: 'scheduled', jobId: expect.any(String) })
    await call('jobs.cancel', { jobId: a.jobId })
    expect((await call<JobInfo & { status: string }>('jobs.get', { jobId: a.jobId })).state).toBe('cancelled')
    expect((await call<JobInfo & { status: string }>('jobs.retry', { jobId: a.jobId })).state).toBe('queued')
    const first = await call<JobInfo & { status: string }>('terms.analyze', { kind: 'tag' })
    expect((await call<JobInfo & { status: string }>('terms.analyze', { kind: 'tag' })).jobId).toBe(first.jobId)
    expect(await call('daily.view', { date: '2026-11-19' })).toMatchObject({ stats: { notes: 1 }, daily: null })
    const daily = await call<JobInfo & { status: string }>('daily.generate', { date: '2026-11-19' })
    expect((await call<JobInfo & { status: string }>('daily.generate', { date: '2026-11-19' })).jobId).toBe(daily.jobId)
    const imported = app.file('content/工作/附件.txt')
    fs.writeFileSync(imported, '原始附件内容')
    await app.core.mutate(() => app.core.vault.metadata.markImported('content/工作/附件.txt', '2026-11-19'))
    await app.core.idle()
    const summary = await call<JobInfo & { status: string }>('files.summarize', { path: 'content/工作/附件.txt' })
    expect(summary).toMatchObject({ jobId: expect.any(String), state: 'queued' })
    expect(app.fake.requests).toHaveLength(0)
  })

  it('已有日总结和摘要重生成先确认，不同操作不共用一次覆盖授权', async () => {
    const file = 'content/工作/材料.txt'
    app.write(file, '材料正文')
    await app.core.mutate(() => app.core.vault.metadata.markImported(file, '2026-11-19'))
    app.write('wiki/sources/2026/11/材料.md', '---\ntype: source-summary\nsource: content/工作/材料.txt\n---\n已人工编辑的摘要')
    app.write('journal/2026/2026-11-19.md', '---\ntype: daily\ndate: 2026-11-19\n---\n人工回顾')
    await app.core.syncIndex()
    const confirm = vi.fn(async (_title: string, _targets: Parameters<OperationContext['confirm']>[1]) => false); context.confirm = confirm
    await expect(call<JobInfo & { status: string }>('files.summarize', { path: file })).rejects.toThrow('取消')
    await expect(call<JobInfo & { status: string }>('daily.generate', { date: '2026-11-19' })).rejects.toThrow('取消')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(app.core.jobs.list().total).toBe(0)
  })

  it('历史会话可查询改名导出删除，当前会话禁止自删除；窗口取消不落文件', async () => {
    const id = app.core.agent.create().conversationId
    await call('conversations.rename', { conversationId: id, title: '历史讨论' })
    expect((await call<{ total: number }>('conversations.list', { text: '历史讨论' })).total).toBe(1)
    expect((await call<{ messages: { total: number } }>('conversations.get', { conversationId: id })).messages.total).toBe(0)
    expect(await call('conversations.export', { conversationId: id, format: 'markdown' })).toEqual({ cancelled: true })
    const target = path.join(app.tmp.dir, '对话.md')
    app.core.operations.setPlatform({ trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, saveFile: async () => target })
    expect(await call('conversations.export', { conversationId: id, format: 'markdown' })).toEqual({ path: target })
    expect(fs.readFileSync(target, 'utf8')).toContain('历史讨论')
    await expect(call('conversations.delete', { ids: [context.conversationId] })).rejects.toThrow('当前会话')
    context.confirm = async () => false
    await expect(call('conversations.delete', { ids: [id] })).rejects.toThrow('取消')
    context.confirm = async () => true
    expect(await call('conversations.delete', { ids: [id] })).toEqual({ deleted: [id], failed: [] })
    expect(fs.existsSync(target)).toBe(true)
  })

  it('系统窗口选择导入保持原件字节；公开设置不含密钥，设置变更通知前端', async () => {
    const source = path.join(app.tmp.dir, '导入资料.md'), bytes = Buffer.from('---\ntags: [原标签]\n---\n资料字节')
    fs.writeFileSync(source, bytes)
    app.core.operations.setPlatform({ trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => [source], saveFile: async () => null })
    const imported = await call<{ imported: string[] }>('files.import', { toDir: 'content/工作' })
    expect(fs.readFileSync(app.file(imported.imported[0]!))).toEqual(bytes)
    expect(JSON.stringify(await call('settings.get'))).not.toContain('"apiKey"')
    const changed = vi.fn()
    app.core.settings.onChange(changed)
    await call('settings.set', { appearance: { theme: 'dark' }, daily: { time: '22:00' } })
    expect(changed).toHaveBeenCalled()
    expect(app.core.settings.get()).toMatchObject({ appearance: { theme: 'dark' }, daily: { time: '22:00' } })
    await expect(call('settings.set', { daily: { time: '99:00' } })).rejects.toThrow()
    context.confirm = async () => false
    await expect(call('settings.set', { maintenance: { trashRetentionDays: 30 } })).rejects.toThrow('取消')
    expect(app.core.settings.get().maintenance.trashRetentionDays).toBe(0)
  })

  it('严格材料不能通过管理工具扩大读取，文件名搜索仍发现指定目录的新文件', async () => {
    app.write('content/工作/指定.md', '指定事实')
    app.write('content/生活/其他.md', '其他事实')
    await app.core.syncIndex()
    context.scope = { materials: [{ kind: 'folder', value: 'content/工作' }] }
    for (const [name, args] of [
      ['conversations.list', {}], ['daily.generate', { date: '2026-11-19' }],
      ['terms.rename', { kind: 'tag', from: 'a', to: 'b' }], ['jobs.list', {}],
    ] as const) await expect(call(name, args)).rejects.toThrow('限定材料')
    await expect(call<JobInfo & { status: string }>('pending.analyze', { path: 'content/生活/其他.md' })).rejects.toThrow('限定材料')
    const note = await call<DocMeta>('records.note', { title: '指定待处理', body: '事实' })
    expect((await call<Paged<InboxItem>>('pending.list')).total).toBe(0)
    expect(fs.existsSync(app.file(note.path))).toBe(true)
  })

  it('系统窗口等待中停止不会迟到导入或导出，维护可在自身工具轮内执行且不删内容', async () => {
    const source = path.join(app.tmp.dir, '不会导入.txt'), target = path.join(app.tmp.dir, '不会导出.md')
    fs.writeFileSync(source, '原字节')
    const entered = deferred(), release = deferred(), controller = new AbortController()
    app.core.operations.setPlatform({
      trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => { entered.release(); await release.promise; return [source] },
      saveFile: async () => target,
    })
    context.signal = controller.signal
    const result = call('files.import')
    await entered.promise
    controller.abort(); release.release()
    await expect(result).rejects.toThrow('已停止')
    expect((await app.call('files:list', {})).total).toBe(0)
    context.signal = undefined
    const exportEntered = deferred(), exportRelease = deferred(), exportController = new AbortController()
    app.core.operations.setPlatform({
      trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null,
      saveFile: async () => { exportEntered.release(); await exportRelease.promise; return target },
    })
    context.signal = exportController.signal
    const exporting = call('conversations.export', { conversationId: context.conversationId, format: 'markdown' })
    await exportEntered.promise
    exportController.abort(); exportRelease.release()
    await expect(exporting).rejects.toThrow('已停止')
    expect(fs.existsSync(target)).toBe(false)
    context.signal = undefined
    app.write('content/工作/保留.md', '用户正文')
    await app.core.idle()
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'maintenance.optimize', args: {} } } }),
      () => '维护已完成。',
    ]))
    const { runId } = app.core.agent.send(context.conversationId, '维护数据库')
    await app.core.agent.wait(runId)
    expect(app.core.agent.get(context.conversationId).messages.at(-1)?.toolCalls?.[0]).toMatchObject({ ok: true })
    expect(fs.readFileSync(app.file('content/工作/保留.md'), 'utf8')).toBe('用户正文')
  })

  it('确认期间词条新增影响文件则停止全局解除，不把新文件默认为已确认', async () => {
    app.write('content/工作/原范围.md', '---\ntags: [同标签]\n---\n正文')
    await app.core.syncIndex()
    context.confirm = async () => {
      app.write('content/工作/新范围.md', '---\ntags: [同标签]\n---\n新正文')
      await app.core.syncIndex()
      return true
    }
    await expect(call('terms.remove', { kind: 'tag', name: '同标签' })).rejects.toThrow('范围新增')
    expect((await app.core.vault.read({ path: 'content/工作/原范围.md' })).classification.tags).toEqual(['同标签'])
  })
  it('真实Pi多步链路可建目录笔记、改属性、归档、回收和恢复；确认只发生一次', async () => {
    const id = context.conversationId, base = 'content/新建顶层'
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_help', arguments: { group: 'records' } } }),
      () => ({ toolCall: { name: 'create_folder', arguments: { parent: 'content', name: '新建顶层' } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.note', args: { title: '新规则', body: '可核对的事实', dir: base } } } }),
      () => ({ toolCall: { name: 'set_properties', arguments: { path: base + '/新规则.md', patch: { tags: ['业务'] } } } }),
      () => ({ toolCall: { name: 'move', arguments: { path: base + '/新规则.md', targetPath: base + '/最终规则.md' } } }),
      () => ({ toolCall: { name: 'trash', arguments: { paths: [base + '/最终规则.md'] } } }),
      results => ({ toolCall: { name: 'app_manage', arguments: { operation: 'trash.restore', args: { ids: [JSON.parse(results[5]!)[0].trashId] } } } }),
      () => '已按实际结果完成并恢复。',
    ]))
    const { runId } = app.core.agent.send(id, '新建顶层、笔记，打标签，改名回收并恢复')
    await expect.poll(() => {
      const latest = app.core.agent.get(id).messages.at(-1)
      if (latest?.role === 'assistant') throw new Error(JSON.stringify(latest))
      return events.filter(e => e.type === 'tool-update' && e.call.confirmation?.state === 'pending').length
    }, { timeout: 10000 }).toBe(1)
    const pending = events.find(e => e.type === 'tool-update' && e.call.confirmation?.state === 'pending') as Extract<AgentEvent, { type: 'tool-update' }>
    app.core.agent.confirm(runId, pending.call.confirmation!.id, true)
    await app.core.agent.wait(runId)
    const result = app.core.agent.get(id).messages.at(-1)!
    expect(result.error).toBeUndefined()
    expect(result.toolCalls).toHaveLength(7)
    expect(result.toolCalls!.every(tool => tool.ok)).toBe(true)
    expect((await app.core.vault.read({ path: base + '/最终规则.md' })).classification.tags).toEqual(['业务'])
    expect(app.core.index.getDoc(base + '/最终规则.md')).not.toBeNull()
    expect(app.core.agent.conversations().total).toBe(1)
    expect(app.fake.requests.filter(isAgentRequest).length).toBeGreaterThan(7)
  })
})
