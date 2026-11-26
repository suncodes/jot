import fs from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AssistantContext } from '@shared/assistant'
import { agentScript } from '../helpers/fake-llm'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const directory = (path: string, recursive = true) => ({ selection: { kind: 'directory' as const, path, recursive } })
const ideas = { selection: { kind: 'collection' as const, name: 'ideas' as const } }
const properties = { kind: 'properties' as const, properties: { tags: ['待确认'] }, confidence: 0.4, reason: '需要确认' }
async function ask(context?: AssistantContext) {
  const id = app.core.agent.create().conversationId
  const { runId } = await app.call('agent:send', { conversationId: id, text: '核对当前范围', context })
  await app.core.agent.wait(runId)
  const result = app.core.agent.get(id).messages.at(-1)!
  expect(result.error).toBeUndefined()
  return result.toolCalls!
}
function modified(rel: string, time: string) { fs.utimesSync(app.file(rel), new Date(time), new Date(time)) }

it('三类用户目录均可直属和递归查询，默认导航仍只返回 content 子目录', async () => {
  for (const root of ['ideas', 'inbox', 'content']) {
    app.write(root + '/直属.md', '直属')
    app.write(root + '/2026/11/深处.md', '深处')
  }
  await app.core.syncIndex()
  for (const root of ['ideas', 'inbox', 'content']) {
    expect((await app.call('library:query', { scope: directory(root, false) })).items.map(i => i.path)).toEqual([root + '/直属.md'])
    expect((await app.call('library:query', { scope: directory(root) })).total).toBe(2)
    expect((await app.call('content:directories', { parentPath: root, recursive: true })).map(i => i.path)).toContain(root + '/2026/11')
  }
  expect((await app.call('content:directories', { recursive: true })).every(i => i.path.startsWith('content/'))).toBe(true)
  expect((await app.call('library:query', {})).total).toBe(6)
})

it('隐藏、越界、系统目录、失效路径和链接目录不能作为物理查询范围', async () => {
  fs.mkdirSync(app.file('ideas/.隐藏'), { recursive: true })
  fs.symlinkSync(app.file('content/工作'), app.file('ideas/跳转'), 'junction')
  for (const rel of ['ideas/.隐藏', 'ideas/跳转', 'ideas/../../外部', '.jot', 'wiki', 'journal']) {
    await expect(app.call('content:directories', { parentPath: rel })).rejects.toThrow('PATH_OUTSIDE_VAULT')
    await expect(app.call('library:query', { scope: directory(rel) })).rejects.toThrow('PATH_OUTSIDE_VAULT')
  }
  await expect(app.call('library:query', { scope: directory('ideas/不存在') })).rejects.toThrow('NOT_FOUND')
  expect(await app.call('content:directories', { parentPath: 'ideas' })).toEqual([])
})

it('灵感支持标签、月份和最近记录排序，完整筛选后分页，不按最后修改日冒充记录日', async () => {
  app.write('ideas/2026/11/甲.md', '---\ncreated: 2026-11-02T08:00:00+08:00\ntags: [学习/编程]\n---\n甲')
  app.write('ideas/2026/11/乙.md', '---\ncreated: 2026-11-12T08:00:00+08:00\ntags: [学习]\n---\n乙')
  app.write('ideas/2026/10/旧.md', '---\ncreated: 2026-10-12\ntags: [学习]\n---\n旧')
  app.write('inbox/资料.md', '---\ncreated: 2026-11-15\ntags: [学习]\n---\n不属于灵感')
  await app.core.syncIndex()
  const query = { scope: ideas, filter: { tags: ['学习'], from: '2026-11-01', to: '2026-11-30' }, sort: 'created' as const, limit: 1 }
  expect(await app.call('library:query', query)).toMatchObject({ total: 2, items: [{ path: 'ideas/2026/11/乙.md' }] })
  expect((await app.call('library:query', { ...query, offset: 1 })).items[0]?.path).toBe('ideas/2026/11/甲.md')
  expect(app.core.index.filterTerms('tag', { scope: ideas })).toEqual([{ name: '学习', count: 2 }, { name: '学习/编程', count: 1 }])
})

it('普通日期与时间线使用同一组当前日期；显式记录／编辑口径仍可单独指定', async () => {
  const note = 'content/工作/规则.md', idea = 'ideas/补充.md', log = 'ideas/区间.md', source = 'inbox/资料.txt'
  app.write(note, '---\ncreated: 2026-10-01\noccurred_at: 2026-09-20\n---\n规则')
  app.write(idea, '---\ncreated: 2026-11-19\noccurred_at: 2026-09-20\n---\n过去的想法')
  app.write(log, '---\ntype: log\ncreated: 2026-11-19\nstart: 2026-09-19T22:00:00+08:00\nend: 2026-09-21T08:00:00+08:00\n---\n跨日补记')
  app.write(source, '原件')
  app.write(source + '.meta.yaml', 'created: 2026-10-01\ntags: [资料]\n')
  modified(note, '2026-11-19T10:00:00+08:00'); modified(source, '2026-11-19T10:00:00+08:00'); modified(source + '.meta.yaml', '2026-11-19T10:00:00+08:00')
  await app.core.syncIndex()
  const recent = app.core.index.search({ filter: { from: '2026-11-19', to: '2026-11-19' } }).items.map(i => i.doc.path)
  expect(recent.sort()).toEqual([note, source].sort())
  const old = app.core.index.timeline('2026-09-20', '2026-09-20').map(i => i.path)
  expect(old.sort()).toEqual([note, idea, log].sort())
  expect((await app.core.daily.view('2026-09-20')).entries.map(e => e.sourcePath).sort()).toEqual(old.sort())
  expect(app.core.content.library({ scope: { ...ideas, time: { basis: 'recorded', from: '2026-11-19', to: '2026-11-19' } } }).total).toBe(2)
  expect(app.core.content.library({ scope: { ...directory('content'), time: { basis: 'edited', from: '2026-11-19', to: '2026-11-19' } } }).total).toBe(1)
  expect(app.core.content.library({ scope: { ...directory('inbox'), time: { basis: 'imported', from: '2026-10-01', to: '2026-10-01' } } }).total).toBe(1)
})

it('原件和多份摘要按原件位置、日期和属性合并，搜索仍给出真实证据路径', async () => {
  const source = 'inbox/2026/10/资料.txt'
  app.write(source, '原件材料')
  app.write(source + '.meta.yaml', 'created: 2026-10-01\ntags: [原件]\npeople: [甲]\n')
  modified(source, '2026-10-02T12:00:00+08:00')
  for (const n of [1, 2]) app.write('wiki/sources/2026/11/摘要' + n + '.md', '---\ntype: source-summary\nsource: ' + source + '\ncreated: 2026-11-19\ntags: [摘要标签]\n---\n摘要独有证据')
  app.write('wiki/sources/孤立.md', '---\ntype: source-summary\nsource: content/缺失.txt\n---\n独立保存的摘要')
  await app.core.syncIndex()
  app.core.state.setSuggestion(source, properties)
  const filter = { from: '2026-10-01', to: '2026-10-01', tags: ['原件'] }
  const listed = await app.call('library:query', { pending: true, filter })
  expect(listed.total).toBe(1)
  expect(listed.items[0]).toMatchObject({ path: source, summaryPaths: expect.arrayContaining(['wiki/sources/2026/11/摘要1.md', 'wiki/sources/2026/11/摘要2.md']) })
  const found = app.core.index.search({ text: '摘要独有', filter })
  expect(found.total).toBe(1); expect(found.items[0]?.chunk.path).toMatch(/^wiki\/sources\//)
  expect(app.core.index.statistics('tag', filter)).toEqual({ total: 1, groups: [{ key: '原件', count: 1 }] })
  expect(app.core.index.filterTerms('tag', { scope: directory('inbox') })).toEqual([{ name: '原件', count: 1 }])
  expect((await app.call('library:query', {})).total).toBe(2)
  expect((await app.call('classify:inbox', {})).total).toBe(1)
  expect((await app.call('library:query', { scope: ideas })).total).toBe(0)
})

it('待处理是 inbox 与属性建议并集，并与显式目录范围取交集', async () => {
  app.write('ideas/无属性.md', '无需归档'); app.write('ideas/有建议.md', '属性待确认')
  app.write('inbox/待归档.md', '没有状态也在待处理'); app.write('content/工作/正式.md', '属性待确认')
  await app.core.syncIndex()
  app.core.state.setSuggestion('ideas/有建议.md', properties)
  app.core.state.setSuggestion('inbox/待归档.md', properties)
  app.core.state.setSuggestion('content/工作/正式.md', properties)
  expect(app.core.content.library({ pending: true }).total).toBe(3)
  expect(app.core.content.library({ pending: true, scope: directory('ideas') }).items.map(i => i.path)).toEqual(['ideas/有建议.md'])
  app.core.state.removeSuggestion('inbox/待归档.md')
  expect(app.core.content.library({ pending: true, scope: directory('inbox') }).total).toBe(1)
  await app.reopen({ removeIndex: true })
  expect(app.core.content.library({ pending: true }).total).toBe(3)
  expect(app.core.content.library({ scope: ideas }).total).toBe(2)
  expect(app.fake.requests).toHaveLength(0)
})

it('严格 @灵感目录约束读取、搜索、词表、统计和时间线，不被目录参数或旧关联扩散', async () => {
  const selected = 'ideas/2026/11'
  app.write(selected + '/材料.md', '---\ncreated: 2026-11-19\ntags: [灵感标签]\n---\n选中灵感材料')
  app.write('ideas/2026/10/其他.md', '---\ncreated: 2026-11-19\ntags: [其他灵感]\n---\n其他灵感')
  app.write('content/工作/其他.md', '---\ncreated: 2026-11-19\nrelated: [' + selected + ']\ntags: [范围外标签]\n---\n范围外机密')
  await app.core.syncIndex()
  app.fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'search', arguments: {} } }),
    () => ({ toolCall: { name: 'search', arguments: { directory: 'content/工作' } } }),
    () => ({ toolCall: { name: 'list_tags', arguments: {} } }),
    () => ({ toolCall: { name: 'stats', arguments: { groupBy: 'folder' } } }),
    () => ({ toolCall: { name: 'timeline', arguments: { from: '2026-11-19' } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: 'content/工作/其他.md' } } }),
    () => '核对完成',
  ]))
  const calls = await ask({ agentId: 'default', strict: true, skillIds: [], references: [{ kind: 'folder', value: selected, title: '11' }] })
  expect(calls[0]!.output).toContain('选中灵感材料')
  expect(calls[1]!.output).toContain('没有找到')
  expect(calls[2]!.output).toBe('灵感标签：1')
  expect(calls[3]!.output).toContain('合计：1')
  expect(calls[4]!.output).toContain('选中灵感材料')
  expect(calls[5]).toMatchObject({ ok: false, output: expect.stringContaining('超出本轮限定材料') })
  expect(calls.map(c => c.output).join('\n')).not.toContain('范围外机密')
})

it('助手日期条件在超过 200 条候选的分页前生效', async () => {
  for (let i = 0; i < 215; i++) app.write('ideas/批量/' + i + '.md', '---\ncreated: 2026-12-01\n---\n共同检索词')
  const target = 'ideas/批量/最后目标.md'
  app.write(target, '---\ncreated: 2026-10-03\n---\n共同检索词 唯一日期证据')
  await app.core.syncIndex()
  expect(app.core.content.library({ scope: directory('ideas/批量'), offset: 200, limit: 200 })).toMatchObject({ total: 216, items: expect.any(Array) })
  const pages = [0, 200].flatMap(offset => app.core.index.search({ text: '共同检索词', filter: { scope: ideas }, offset, limit: 200 }).items.map(i => i.doc.path))
  expect(new Set(pages).size).toBe(216)
  app.fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'search', arguments: { query: '共同检索词', from: '2026-10-03', to: '2026-10-03' } } }),
    () => ({ toolCall: { name: 'stats', arguments: { groupBy: 'type', from: '2026-10-03', to: '2026-10-03' } } }),
    () => '已找到',
  ]))
  const calls = await ask()
  expect(calls[0]!.output).toContain('唯一日期证据')
  expect(calls[1]!.output).toContain('合计：1')
})

it('仅附件属性更新也能由索引和助手时间线按同一天查到', async () => {
  const source = 'inbox/2026/10/资料.txt'
  app.write(source, '旧正文不能据此推断进展')
  app.write(source + '.meta.yaml', 'created: 2026-10-01\ntags: [新属性]\n')
  modified(source, '2026-10-02T08:00:00+08:00')
  modified(source + '.meta.yaml', '2026-11-19T08:00:00+08:00')
  await app.core.syncIndex()
  app.fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'timeline', arguments: { from: '2026-11-19' } } }),
    () => '完成',
  ]))
  const calls = await ask()
  expect(calls[0]!.output).toContain(source)
  expect(calls[0]!.output).toContain('具体变化未确认')
  expect(calls[0]!.output).not.toContain('旧正文')
  expect((await app.core.vault.read({ path: source })).modified).toBe(app.core.index.getDoc(source)!.modified)
})

it('助手按原件日期检索摘要，不按生成日再次剔除证据', async () => {
  const source = 'inbox/原件.txt'
  app.write(source, '无关键词')
  app.write(source + '.meta.yaml', 'created: 2026-10-03\ntags: [资料]\n')
  modified(source, '2026-10-04T08:00:00+08:00')
  app.write('wiki/sources/2026/11/摘要.md', '---\ntype: source-summary\nsource: ' + source + '\ncreated: 2026-11-19\n---\n摘要独有关键词')
  await app.core.syncIndex()
  app.fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'search', arguments: { query: '摘要独有关键词', from: '2026-10-03', to: '2026-10-03' } } }),
    () => ({ toolCall: { name: 'stats', arguments: { groupBy: 'type', from: '2026-10-03', to: '2026-10-03' } } }),
    () => '完成',
  ]))
  const calls = await ask()
  expect(calls[0]!.output).toContain('wiki/sources/2026/11/摘要.md')
  expect(calls[0]!.output).toContain('摘要独有关键词')
  expect(calls[1]!.output).toContain('合计：1')
})

it('外部新增、正文和 sidecar 变化只更新相关投影；刷新与重建不调用 AI', async () => {
  const idea = 'ideas/2026/11/外部.md', source = 'inbox/2026/11/外部.txt'
  app.write(idea, '原始灵感'); app.write(source, '原始资料')
  await expect.poll(() => app.core.index.allPaths()).toEqual(expect.arrayContaining([idea, source]))
  await app.core.idle()
  const upsert = vi.spyOn(app.core.index, 'upsert')
  await app.core.syncIndex()
  expect(upsert).not.toHaveBeenCalled()
  app.write(source + '.meta.yaml', 'tags: [外部标签]\npeople: [外部人物]\n')
  await expect.poll(() => app.core.index.getDoc(source)?.classification.tags).toEqual(['外部标签'])
  expect(upsert.mock.calls.map(c => c[0].path)).toEqual([source])
  upsert.mockClear()
  app.write(idea, '外部改过的当前灵感和新词')
  await app.core.refreshIndex([idea])
  await app.core.idle()
  expect(upsert.mock.calls.map(c => c[0].path)).toEqual([idea])
  fs.unlinkSync(app.file(source + '.meta.yaml'))
  await app.core.refreshIndex([source + '.meta.yaml'])
  expect(app.core.index.getDoc(source)?.classification.tags).toEqual([])
  fs.renameSync(app.file(source), app.file('content/工作/外部.txt'))
  await app.core.syncIndex()
  expect(app.core.content.library({ pending: true }).total).toBe(0)
  expect(app.core.content.library({}).total).toBe(2)
  await app.reopen({ removeIndex: true })
  expect(app.core.index.search({ text: '新词', filter: { scope: ideas } }).total).toBe(1)
  expect(app.core.content.library({ pending: true }).total).toBe(0)
  expect(app.fake.requests).toHaveLength(0)
})

it.each([
  ['library:query', { filter: { from: '2026-02-30' } }],
  ['library:query', { filter: { from: '2026-11-20', to: '2026-11-01' } }],
  ['library:query', { filter: { scope: ideas } }],
  ['library:query', { filter: { materials: [] } }],
  ['search:query', { filter: { to: '2026-04-31' } }],
  ['search:query', { filter: { domain: '工作' } }],
  ['search:query', { filter: { scope: { ...ideas, includeRelated: true } } }],
] as const)('拒绝无效日期和旧范围参数：%s %j', async (channel, args) => {
  await expect(app.call(channel, args as never)).rejects.toThrow('INVALID_INPUT')
})
