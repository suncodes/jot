import fs from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { testApp } from '../helpers/test-app'
let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
it('应用内移动维护普通链接和双链，重建重启按当前文本解析', async () => {
  const target = await app.call('doc:create', { dir: 'content/工作', title: '目标', body: '规则' })
  const source = await app.call('doc:create', { dir: 'content/生活', title: '引用', body: '[规则](../工作/目标.md) [[content/工作/目标]]' })
  await app.call('doc:rename', { ref: { path: target.path }, newName: '新目标' })
  await app.core.syncIndex(true); await app.reopen()
  const text = (await app.core.vault.read({ path: source.path })).body
  expect(text).toContain('新目标')
  expect((await app.call('doc:resolveLink', { from: source.path, target: '../工作/新目标.md', kind: 'markdown' })).path).toBe('content/工作/新目标.md')
})
it('删除保留别处链接，外部移动允许断链，不按旧 id 或内容猜测', async () => {
  app.write('content/工作/目标.md', '---\nid: custom\n---\n原文')
  app.write('content/入口.md', '[目标](工作/目标.md)'); await app.core.syncIndex()
  fs.renameSync(app.file('content/工作/目标.md'), app.file('content/工作/外部移动.md')); await app.core.syncIndex()
  await expect(app.call('doc:resolveLink', { from: 'content/入口.md', target: '工作/目标.md', kind: 'markdown' })).rejects.toThrow('NOT_FOUND')
  expect((await app.core.vault.read({ path: 'content/入口.md' })).body).toContain('工作/目标.md')
})
it('灵感与待归档跨根移动后维护普通链接，重建不恢复旧目录关联', async () => {
  const idea = 'ideas/2026/11/想法.md', pending = 'inbox/2026/11/素材.md', moved = 'content/工作/素材.md'
  app.write(idea, '[素材](../../../inbox/2026/11/素材.md#细节)\n[[inbox/2026/11/素材]]')
  app.write(pending, '[想法](../../../ideas/2026/11/想法.md)\n[规则](../../../content/工作/规则.md)')
  app.write('content/工作/规则.md', '---\nrelated: [inbox/2026/11]\n---\n规则')
  await app.core.syncIndex()
  await app.call('content:move', { path: pending, targetPath: moved })
  expect(decodeURI((await app.core.vault.read({ path: idea })).body)).toContain('../../../content/工作/素材.md#细节')
  expect(decodeURI((await app.core.vault.read({ path: moved })).body)).toContain('[想法](../../ideas/2026/11/想法.md)')
  expect((await app.core.vault.read({ path: moved })).body).toContain('[规则](' + encodeURI('规则.md') + ')')
  await app.reopen({ removeIndex: true })
  expect((await app.call('doc:resolveLink', { from: idea, target: '../../../content/工作/素材.md#细节', kind: 'markdown' })).path).toBe(moved)
  expect((await app.call('doc:resolveLink', { from: idea, target: 'content/工作/素材', kind: 'wiki' })).path).toBe(moved)
  expect((await app.call('doc:properties', { path: 'content/工作/规则.md' })).data.related).toEqual(['inbox/2026/11'])
  expect((await app.call('library:query', { pending: true })).total).toBe(0)
})

it('同名双链有歧义时提示，不猜测；标准相对路径可精确解析', async () => {
  app.write('content/工作/同名.md', '甲'); app.write('content/生活/同名.md', '乙'); await app.core.syncIndex()
  await expect(app.call('doc:resolveLink', { from: 'inbox/入口.md', target: '同名', kind: 'wiki' })).rejects.toThrow('CONFLICT')
  expect((await app.call('doc:resolveLink', { from: 'content/入口.md', target: '工作/同名.md', kind: 'markdown' })).path).toBe('content/工作/同名.md')
})
