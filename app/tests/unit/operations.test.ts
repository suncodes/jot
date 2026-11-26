import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { testApp } from '../helpers/test-app'
let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
it('附件、sidecar 和所有摘要可整组回收恢复，重建不依赖文件登记表', async () => {
  app.write('content/工作/资料.txt', '原件'); await app.core.syncIndex()
  await app.call('doc:patchProperties', { path: 'content/工作/资料.txt', patch: { tags: ['业务'], related: ['content/工作'] } })
  await app.core.files.summarize('content/工作/资料.txt'); await app.core.idle()
  const summary = app.core.files.summaries('content/工作/资料.txt')[0]!
  const trash = await app.call('library:delete', { path: 'content/工作/资料.txt', scope: 'entry' })
  expect(fs.existsSync(app.file(summary))).toBe(false)
  expect(fs.existsSync(app.file('content/工作/资料.txt.meta.yaml'))).toBe(false)
  const restored = await app.call('doc:restore', trash)
  await app.core.syncIndex(true)
  expect(app.core.files.list().items[0]).toMatchObject({ path: restored.path, classification: { tags: ['业务'] }, summaryPath: summary })
})
it('只回收原件时保留摘要，恢复重名时保留新文件及其链接', async () => {
  app.write('content/资料.txt', '原件'); await app.core.syncIndex(); await app.core.files.summarize('content/资料.txt')
  const summary = app.core.files.summaries('content/资料.txt')[0]!
  const trash = await app.call('library:delete', { path: 'content/资料.txt', scope: 'source' })
  app.write('content/资料.txt', '新占位原件'); await app.core.syncIndex()
  const restored = await app.call('doc:restore', trash)
  expect(restored.path).not.toBe('content/资料.txt')
  expect((await app.core.vault.read({ path: 'content/资料.txt' })).body).toBe('新占位原件')
  expect((await app.core.vault.read({ path: summary })).sourcePath).toBe('content/资料.txt')
})
it('目录改名、移动、回收与恢复保留空子目录和文件属性', async () => {
  await app.call('vault:createFolder', { parent: 'content/工作', name: '客户A' })
  await app.call('vault:createFolder', { parent: 'content/工作/客户A', name: '空目录' })
  const doc = await app.call('doc:create', { dir: 'content/工作/客户A', title: '规则', body: '规则正文' })
  await app.call('doc:setClassification', { ref: { path: doc.path }, patch: { tags: ['业务'] } })
  const moved = await app.call('folder:move', { path: 'content/工作/客户A', toDir: 'content/生活', name: '客户B' })
  expect(moved.path).toBe('content/生活/客户B')
  const trash = await app.call('folder:delete', { path: moved.path })
  await app.call('folder:restore', trash)
  expect(fs.statSync(app.file('content/生活/客户B/空目录')).isDirectory()).toBe(true)
  expect((await app.core.vault.read({ path: 'content/生活/客户B/规则.md' })).classification.tags).toEqual(['业务'])
})
it('附件组目标重名拒绝操作，不覆盖目标的附属属性', async () => {
  app.write('content/甲.txt', '甲'); app.write('content/乙.txt.meta.yaml', 'tags: [乙]')
  await app.core.syncIndex()
  await expect(app.call('content:move', { path: 'content/甲.txt', targetPath: 'content/乙.txt' })).rejects.toThrow('CONFLICT')
  expect(fs.readFileSync(app.file('content/乙.txt.meta.yaml'), 'utf8')).toBe('tags: [乙]')
})
it('导入 Markdown 的属性编辑保存到 sidecar，原件字节保持', async () => {
  const source = path.join(app.tmp.dir, '导入.md'), raw = Buffer.from('---\ntags: [原标签]\n---\n资料')
  fs.writeFileSync(source, raw)
  const result = await app.call('files:import', { paths: [source], toDir: 'content/工作' })
  await app.call('doc:setClassification', { ref: { path: result.imported[0]! }, patch: { tags: ['新属性'] } })
  expect(fs.readFileSync(app.file(result.imported[0]!))).toEqual(raw)
})
