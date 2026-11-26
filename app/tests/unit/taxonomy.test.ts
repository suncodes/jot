import fs from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { testApp } from '../helpers/test-app'
let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { vi.restoreAllMocks(); await app.close() })
it('预置词条从零计数开始，应用和索引重建后保留，使用次数随文件属性变化', async () => {
  await app.call('taxonomy:create', { kind: 'tag', name: '  客户项目  ' })
  await app.call('taxonomy:create', { kind: 'place', name: '会议室' })
  await app.call('taxonomy:create', { kind: 'person', name: '小周' })
  await expect(app.call('taxonomy:create', { kind: 'tag', name: '客户项目' })).rejects.toThrow('CONFLICT')
  await expect(app.call('taxonomy:create', { kind: 'tag', name: '   ' })).rejects.toThrow('INVALID_INPUT')
  await expect(app.call('taxonomy:create', { kind: 'tag', name: '甲\n乙' })).rejects.toThrow('INVALID_INPUT')
  expect(await app.core.vault.listFiles()).toEqual([])
  await app.reopen({ removeIndex: true })
  expect(await app.call('taxonomy:terms', { kind: 'tag' })).toEqual([{ name: '客户项目', state: 'official', count: 0 }])
  expect(await app.call('taxonomy:terms', { kind: 'place' })).toEqual([{ name: '会议室', state: 'official', count: 0 }])
  expect(await app.call('taxonomy:terms', { kind: 'person' })).toEqual([{ name: '小周', state: 'official', count: 0 }])

  const ref = { path: 'content/工作/进展.md' }
  app.write(ref.path, '实际内容')
  await app.core.syncIndex()
  await app.call('doc:setClassification', { ref, patch: { tags: ['客户项目', '临时标签'], people: ['小周'], place: '会议室' } })
  expect(await app.call('taxonomy:terms', { kind: 'tag' })).toEqual(expect.arrayContaining([
    { name: '客户项目', state: 'official', count: 1 }, { name: '临时标签', state: 'official', count: 1 },
  ]))
  await expect(app.call('taxonomy:create', { kind: 'tag', name: '临时标签' })).rejects.toThrow('CONFLICT')
  await app.call('doc:setClassification', { ref, patch: { tags: [], people: [], place: null } })
  expect(await app.call('taxonomy:terms', { kind: 'tag' })).toEqual([{ name: '客户项目', state: 'official', count: 0 }])
  expect((await app.core.vault.read(ref)).body).toBe('实际内容')
})
it('尚无关联文件的预置词条可改名、合并和删除', async () => {
  await app.call('taxonomy:create', { kind: 'tag', name: '原名' })
  await app.call('taxonomy:create', { kind: 'tag', name: '目标' })
  expect(await app.call('taxonomy:rename', { kind: 'tag', from: '原名', to: '新名' })).toMatchObject({ affected: 0, failed: [] })
  expect((await app.call('taxonomy:terms', { kind: 'tag' })).map(term => term.name)).toEqual(expect.arrayContaining(['新名', '目标']))
  expect(await app.call('taxonomy:merge', { kind: 'tag', from: ['目标'], into: '合并后' })).toMatchObject({ affected: 0, failed: [] })
  expect(await app.call('taxonomy:remove', { kind: 'tag', name: '新名' })).toMatchObject({ affected: 0, failed: [] })
  expect(await app.call('taxonomy:terms', { kind: 'tag' })).toEqual([{ name: '合并后', state: 'official', count: 0 }])
})
it('标签改名支持层级，合并按文件去重，原件只写 sidecar', async () => {
  app.write('content/工作/笔记.md', '---\ntags: [旧, 旧/细分]\n---\n正文')
  app.write('content/资料.txt', '原件')
  await app.core.syncIndex()
  await app.call('doc:patchProperties', { path: 'content/资料.txt', patch: { tags: ['旧'] } })
  const renamed = await app.call('taxonomy:rename', { kind: 'tag', from: '旧', to: '新' })
  expect(renamed).toMatchObject({ affected: 2, failed: [] })
  expect((await app.core.vault.read({ path: 'content/工作/笔记.md' })).classification.tags).toEqual(['新', '新/细分'])
  expect(fs.readFileSync(app.file('content/资料.txt'), 'utf8')).toBe('原件')
  const merged = await app.call('taxonomy:merge', { kind: 'tag', from: ['新', '新/细分'], into: '统一' })
  expect(merged.affected).toBe(2)
})
it('批量操作逐文件返回部分成功，不因某一文件非法 YAML 丢掉其他结果', async () => {
  app.write('content/甲.md', '---\ntags: [旧]\n---\n甲')
  app.write('content/乙.md', '---\ntags: [旧]\n---\n乙'); await app.core.syncIndex()
  const pathsUsing = app.core.index.pathsUsing.bind(app.core.index)
  vi.spyOn(app.core.index, 'pathsUsing').mockImplementation((...args) => {
    const paths = pathsUsing(...args)
    // 模拟候选选出后，外部编辑器把其中一个文件改成无效 YAML。
    app.write('content/乙.md', '---\ntags: [未闭合\n---\n乙')
    return paths
  })
  const result = await app.call('taxonomy:rename', { kind: 'tag', from: '旧', to: '新' })
  expect(result).toMatchObject({ affected: 1, updated: ['content/甲.md'], failed: [{ path: 'content/乙.md' }] })
  expect(fs.readFileSync(app.file('content/乙.md'), 'utf8')).toContain('[未闭合')
})
it('修改前回读当前属性，索引过期不会把用户已改的标签换回', async () => {
  app.write('content/笔记.md', '---\ntags: [旧]\n---\n正文'); await app.core.syncIndex()
  app.write('content/笔记.md', '---\ntags: [人工最新]\n---\n正文')
  expect((await app.call('taxonomy:rename', { kind: 'tag', from: '旧', to: '新' })).affected).toBe(0)
  expect((await app.core.vault.read({ path: 'content/笔记.md' })).classification.tags).toEqual(['人工最新'])
})
it('人物和地点解除仅修改属性；未知键与文件正文保留', async () => {
  app.write('content/笔记.md', '---\npeople: [小王, 小李]\nplace: 北京\ncustom: 保留\n---\n正文')
  await app.core.syncIndex()
  await app.call('taxonomy:remove', { kind: 'person', name: '小王' })
  await app.call('taxonomy:rename', { kind: 'place', from: '北京', to: '上海' })
  const doc = await app.core.vault.read({ path: 'content/笔记.md' })
  expect(doc.properties).toMatchObject({ people: ['小李'], place: '上海', custom: '保留' })
  expect(doc.body).toBe('正文')
})
it('标签改名只撤销标签建议，保留待归档目录与地点建议', async () => {
  const file = 'inbox/资料.md'
  app.write(file, '---\ntags: [旧]\n---\n正文')
  await app.core.syncIndex()
  app.core.state.setSuggestion(file, { kind: 'directory', directoryPath: 'content/工作', confidence: 0.8, reason: '' })
  app.core.state.setSuggestion(file, { kind: 'properties', properties: { tags: ['旧候选'], place: '公司' }, confidence: 0.8, reason: '' })
  expect((await app.call('taxonomy:rename', { kind: 'tag', from: '旧', to: '新' })).affected).toBe(1)
  expect(app.core.state.getSuggestions(file)).toEqual([
    expect.objectContaining({ kind: 'directory' }),
    expect.objectContaining({ kind: 'properties', properties: { place: '公司' } }),
  ])
  expect(app.core.classify.inbox({}).items[0]?.reasons).toEqual(['directory', 'properties'])
})
it('同义建议保留用户确认入口，过滤模型编造名称和重复分组', async () => {
  app.write('content/笔记.md', '---\ntags: [零食, 小吃]\n---\n正文'); await app.core.syncIndex()
  app.fake.setResponder(() => JSON.stringify({ groups: [{ names: ['零食', '小吃', '不存在'], suggested: '零食', reason: '同义' }] }))
  await app.core.taxonomy.findSynonyms('tag')
  const groups = app.core.taxonomy.synonyms()
  expect(groups).toMatchObject([{ kind: 'tag', names: ['零食', '小吃'] }])
  await app.core.taxonomy.merge('tag', groups[0]!.names, '零食')
  expect(app.core.taxonomy.synonyms()).toHaveLength(0)
})
