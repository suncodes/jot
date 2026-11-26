import { afterEach, beforeEach, expect, it } from 'vitest'
import { testApp } from '../helpers/test-app'
let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const scope = (path: string, recursive = true) => ({ selection: { kind: 'directory' as const, path, recursive } })
it('目录来自物理 content，含空目录，不把系统根接入主树', async () => {
  await app.call('vault:createFolder', { parent: 'content/工作', name: '空目录' })
  expect(app.core.content.directories('content/工作')).toMatchObject([{ path: 'content/工作/空目录', name: '空目录' }])
  expect(app.core.content.directories().every(d => d.path.startsWith('content/'))).toBe(true)
})
it('物理直属与递归范围不再被旧 related 字段扩散', async () => {
  app.write('content/工作/A/规则.md', '规则')
  app.write('content/工作/A/子目录/深入.md', '深入')
  app.write('inbox/外部.md', '---\nrelated: [content/工作/A]\n---\n旧字段')
  await app.core.syncIndex()
  expect(app.core.content.library({ scope: scope('content/工作/A', false) }).total).toBe(1)
  expect(app.core.content.library({ scope: scope('content/工作/A') }).total).toBe(2)
})
it('灵感与待归档按实际路径分离，无类型／状态属性亦可重建', async () => {
  app.write('ideas/2026/11/灵感.md', '一个想法')
  app.write('inbox/2026/11/资料.md', '资料')
  app.write('content/生活/笔记.md', '笔记')
  await app.core.syncIndex()
  expect(app.core.content.library({ scope: { selection: { kind: 'collection', name: 'ideas' } } }).items.map(i => i.path)).toEqual(['ideas/2026/11/灵感.md'])
  expect(app.core.classify.inbox({}).items.map(i => i.doc.path)).toEqual(['inbox/2026/11/资料.md'])
  expect(app.core.content.library({}).total).toBe(3)
  await app.reopen({ removeIndex: true })
  expect(app.core.classify.inbox({}).total).toBe(1)
  expect(app.core.content.library({ scope: { selection: { kind: 'collection', name: 'ideas' } } }).total).toBe(1)
})
it('同内容不同路径独立，摘要与原件配对去重', async () => {
  app.write('content/甲.txt', '共同规则'); app.write('content/乙.txt', '共同规则')
  await app.core.syncIndex()
  await app.core.files.summarize('content/甲.txt')
  await app.core.idle()
  expect(app.core.content.library({}).total).toBe(2)
  expect(app.core.content.search({ text: '规则' }).total).toBe(2)
  expect(app.core.content.stats('type').total).toBe(2)
})
it('限定材料只含物理子树，旧关联内容不能混入', async () => {
  app.write('content/工作/A/规则.md', '范围材料')
  app.write('ideas/关联.md', '---\nrelated: [content/工作/A]\n---\n关联材料')
  await app.core.syncIndex()
  const filter = { materials: [{ kind: 'folder' as const, value: 'content/工作/A' }] }
  expect(app.core.index.search({ filter }).total).toBe(1)
  expect(app.core.index.matchesFilter('ideas/关联.md', filter)).toBe(false)
})
it('移动按当前路径处理，失效目录不按旧自定义 id 找回', async () => {
  app.write('content/工作/A/旧.md', '---\nid: custom\n---\n原文'); await app.core.syncIndex()
  await app.call('folder:move', { path: 'content/工作/A', toDir: 'content/生活', name: '新' })
  await expect(app.call('library:query', { scope: scope('content/工作/A') })).rejects.toThrow('NOT_FOUND')
  expect(app.core.content.library({ scope: scope('content/生活/新') }).items[0]?.path).toBe('content/生活/新/旧.md')
})
