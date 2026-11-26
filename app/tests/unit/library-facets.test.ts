import fs from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ContentScope } from '@shared/storage'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const ideas: ContentScope = { selection: { kind: 'collection', name: 'ideas' } }

it('灵感月份取完整集合的记录时间，标签不受分页影响且按物理根隔离', async () => {
  for (let i = 0; i < 35; i++) app.write('ideas/2026/11/记录' + i + '.md', '---\ncreated: 2026-11-19\ntags: [学习]\n---\n一条想法')
  const old = 'ideas/2026/10/过去.md'
  app.write(old, '---\ncreated: 2026-10-31\noccurred_at: 2026-09-20\ntags: [学习/编程, 少见]\n---\n补记过去的想法')
  app.write('ideas/2026/11/区间.md', '---\ntype: log\ncreated: 2026-11-19\nstart: 2026-08-01T10:00:00+08:00\nend: 2026-08-01T11:00:00+08:00\n---\n更早的事')
  app.write('inbox/资料.md', '---\ncreated: 2026-12-01\ntags: [待归档]\n---\n资料')
  app.write('content/工作/笔记.md', '---\ncreated: 2026-07-01\ntags: [工作]\n---\n笔记')
  fs.utimesSync(app.file(old), new Date('2026-11-20T10:00:00+08:00'), new Date('2026-11-20T10:00:00+08:00'))
  await app.core.syncIndex()
  const first = await app.call('library:query', { scope: ideas, sort: 'created', limit: 30 })
  expect(first.total).toBe(37)
  expect(first.items.map(i => i.path)).not.toContain(old)
  const facets = await app.call('library:facets', { scope: ideas })
  expect(facets.months).toEqual(['2026-11', '2026-10'])
  expect(facets.tags).toEqual(expect.arrayContaining([{ name: '学习', count: 35 }, { name: '学习/编程', count: 1 }, { name: '少见', count: 1 }]))
  expect(facets.tags).toHaveLength(3)
  const filtered: ContentScope = { ...ideas, time: { basis: 'recorded', from: '2026-10-01', to: '2026-10-31' } }
  expect((await app.call('library:query', { scope: filtered, filter: { tags: ['学习'] } })).items.map(i => i.path)).toEqual([old])
  expect((await app.call('content:stats', { scope: ideas, groupBy: 'date' })).groups.map(g => g.key)).toContain('2026-08-01')
  expect(app.fake.requests).toHaveLength(0)
})

it('筛选候选按原件合并多份摘要，附属文件与系统日总结不额外计数', async () => {
  const source = 'ideas/2026/10/资料.txt'
  app.write(source, '灵感附带的材料')
  app.write(source + '.meta.yaml', 'created: 2026-10-31\ntags: [原件, 原件]\n')
  for (const n of [1, 2]) app.write('wiki/sources/2026/11/摘要' + n + '.md', '---\ntype: source-summary\nsource: ' + source + '\ncreated: 2026-11-19\ntags: [摘要]\n---\n摘要内容')
  app.write('journal/2026/2026-11-19.md', '---\ntype: daily\ncreated: 2026-09-01\ntags: [日总结]\n---\n日总结')
  await app.core.syncIndex()
  expect(await app.call('library:facets', { scope: ideas })).toEqual({ months: ['2026-10'], tags: [{ name: '原件', count: 1 }] })
  expect(await app.call('library:facets', {})).toEqual({ months: ['2026-10'], tags: [{ name: '原件', count: 1 }] })
  expect((await app.call('library:query', { scope: ideas })).total).toBe(1)
  expect(app.fake.requests).toHaveLength(0)
})

it('无附加属性的外部灵感仍可筛选，修改和移出后刷新，删除索引也能重建候选', async () => {
  const file = 'ideas/2026/11/外部.md'
  app.write(file, '不依赖属性和状态登记的灵感')
  await app.call('vault:refreshIndex', {})
  const doc = await app.call('doc:get', { ref: { path: file } })
  const initial = await app.call('library:facets', { scope: ideas })
  expect(initial.months).toHaveLength(1)
  expect(initial.tags).toEqual([])
  expect((await app.call('library:query', { scope: ideas })).items[0]?.created).toBe(doc.created)
  await app.call('doc:patchProperties', { path: file, patch: { tags: ['外部标签'], created: '2026-02-28' } })
  const tagged = { months: ['2026-02'], tags: [{ name: '外部标签', count: 1 }] }
  expect(await app.call('library:facets', { scope: ideas })).toEqual(tagged)
  await app.reopen({ removeIndex: true })
  expect(await app.call('library:facets', { scope: ideas })).toEqual(tagged)
  await app.call('doc:move', { ref: { path: file }, toDir: 'content/学习' })
  expect(await app.call('library:facets', { scope: ideas })).toEqual({ months: [], tags: [] })
  expect((await app.call('library:facets', { scope: { selection: { kind: 'directory', path: 'content/学习', recursive: false } } })).tags).toEqual(tagged.tags)
  expect(app.fake.requests).toHaveLength(0)
})

it('新增筛选接口同样拒绝旧关系参数、无效日期、系统和失效目录', async () => {
  for (const args of [
    { limit: 1 }, { scope: { selection: { kind: 'collection', name: 'ideas', includeRelated: true } } },
    { scope: { ...ideas, time: { basis: 'recorded', from: '2026-02-30', to: '2026-03-01' } } },
  ]) await expect(app.call('library:facets', args as { scope?: ContentScope })).rejects.toThrow('INVALID_INPUT')
  await expect(app.call('library:facets', { scope: { selection: { kind: 'directory', path: 'journal', recursive: true } } })).rejects.toThrow('PATH_OUTSIDE_VAULT')
  await expect(app.call('library:facets', { scope: { selection: { kind: 'directory', path: 'ideas/不存在', recursive: true } } })).rejects.toThrow('NOT_FOUND')
  expect(app.fake.requests).toHaveLength(0)
})
