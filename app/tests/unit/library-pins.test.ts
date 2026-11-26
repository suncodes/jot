import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { vi.restoreAllMocks(); await app.close() })
const file = 'content/工作/客户A/规则.md'
const folder = 'content/工作/客户A'
const pin = (path: string, kind: 'file' | 'folder' = 'file', pinned = true) => app.call('library:setPinned', { path, kind, pinned })

it('固定文件和目录仅保存库内路径及顺序，重启和重建索引均保留', async () => {
  expect(await app.call('library:pins', undefined)).toEqual([])
  expect(fs.existsSync(app.file('.jot/library-pins.json'))).toBe(false)
  app.write(file, '正文')
  await pin(file); await pin(folder, 'folder')
  await pin(file)
  expect(await app.call('library:pins', undefined)).toEqual([
    { path: file, kind: 'file', missing: false }, { path: folder, kind: 'folder', missing: false },
  ])
  const config = JSON.parse(fs.readFileSync(app.file('.jot/library-pins.json'), 'utf8'))
  expect(config).toEqual({ pins: [{ path: file, kind: 'file' }, { path: folder, kind: 'folder' }] })
  expect(fs.readFileSync(app.file(file), 'utf8')).toBe('正文')
  await app.reopen({ removeIndex: true })
  expect((await app.call('library:pins', undefined)).map(pin => pin.path)).toEqual([file, folder])
})

it('排序、首尾边界及重复取消固定不丢失其他入口', async () => {
  app.write(file, '正文'); app.write('ideas/2026/11/想法.md', '想法')
  await pin(file); await pin(folder, 'folder'); await pin('ideas/2026/11/想法.md')
  await app.call('library:reorderPin', { path: file, direction: 'up' })
  await app.call('library:reorderPin', { path: folder, direction: 'up' })
  await app.call('library:reorderPin', { path: file, direction: 'down' })
  expect((await app.call('library:pins', undefined)).map(pin => pin.path)).toEqual([folder, 'ideas/2026/11/想法.md', file])
  await pin(folder, 'folder', false); await pin(folder, 'folder', false)
  await app.reopen()
  expect((await app.call('library:pins', undefined)).map(pin => pin.path)).toEqual(['ideas/2026/11/想法.md', file])
})

it('应用内目录移动、文件改名和通用内容移动同步固定路径', async () => {
  app.write(file, '正文')
  await app.core.syncIndex()
  await pin(folder, 'folder'); await pin(file)
  await app.call('folder:move', { path: folder, toDir: 'content/生活', name: '客户B' })
  const moved = 'content/生活/客户B/规则.md'
  expect((await app.call('library:pins', undefined)).map(pin => pin.path)).toEqual(['content/生活/客户B', moved])
  const renamed = await app.call('doc:rename', { ref: { path: moved }, newName: '新版' })
  expect((await app.call('library:pins', undefined))[1]).toEqual({ path: renamed.path, kind: 'file', missing: false })
  await app.call('content:move', { path: renamed.path, targetPath: 'content/工作/最终.md' })
  expect((await app.call('library:pins', undefined))[1]).toEqual({ path: 'content/工作/最终.md', kind: 'file', missing: false })
})

it('文件移入灵感后仍能打开，外部移动不猜身份，恢复原路径自动可用', async () => {
  app.write(file, '正文'); await app.core.syncIndex(); await pin(file)
  const moved = await app.call('doc:move', { ref: { path: file }, toDir: 'ideas' })
  expect((await app.call('library:pins', undefined))[0]).toEqual({ path: moved.path, kind: 'file', missing: false })
  const outside = app.file('ideas/外部改名.md')
  fs.renameSync(app.file(moved.path), outside)
  expect((await app.call('library:pins', undefined))[0]).toMatchObject({ path: moved.path, missing: true })
  fs.renameSync(outside, app.file(moved.path))
  expect((await app.call('library:pins', undefined))[0]?.missing).toBe(false)
})

it('目录回收后显示失效，恢复同一路径后无需重建固定', async () => {
  app.write(file, '正文'); await app.core.syncIndex(); await pin(folder, 'folder'); await pin(file)
  const { trashId } = await app.call('folder:delete', { path: folder })
  expect((await app.call('library:pins', undefined)).every(pin => pin.missing)).toBe(true)
  await app.call('folder:restore', { trashId })
  expect((await app.call('library:pins', undefined)).every(pin => !pin.missing)).toBe(true)
})

it('批量请求串行落盘，切库后固定配置互不影响', async () => {
  app.write(file, '正文')
  await Promise.all([pin(file), pin(folder, 'folder'), pin('content/生活', 'folder')])
  expect(await app.call('library:pins', undefined)).toHaveLength(3)
  const other = path.join(app.tmp.dir, '另一库')
  await app.call('vault:open', { path: other, create: true })
  expect(await app.call('library:pins', undefined)).toEqual([])
  await pin('content/工作', 'folder')
  await app.call('vault:open', { path: app.root, create: false })
  expect((await app.call('library:pins', undefined)).map(pin => pin.path)).toEqual([file, folder, 'content/生活'])
})

it('拒绝越界、隐藏资源、错误类型和不存在的目标，失效入口仍可取消', async () => {
  app.write(file, '正文')
  for (const value of ['../外部.md', '.jot/settings.json', 'templates/模板.md', 'content/../ideas/想法.md', 'content/.hidden.md', 'content/规则.pdf.meta.yaml', app.file(file)]) {
    await expect(pin(value)).rejects.toThrow('INVALID_INPUT')
  }
  await expect(pin('ideas/2026', 'folder')).rejects.toThrow('INVALID_INPUT')
  await expect(pin(folder)).rejects.toThrow('NOT_FOUND')
  await expect(pin(file, 'folder')).rejects.toThrow('NOT_FOUND')
  await expect(pin('content/不存在.md')).rejects.toThrow('NOT_FOUND')
  await pin(file)
  fs.unlinkSync(app.file(file))
  await pin(file, 'file', false)
  expect(await app.call('library:pins', undefined)).toEqual([])
})

it('损坏配置不覆盖，文件移动照常完成并保留诊断', async () => {
  app.write(file, '正文'); await app.core.syncIndex()
  const raw = '{"pins": "无效配置"}'
  app.write('.jot/library-pins.json', raw)
  await expect(pin(file)).rejects.toThrow('配置格式无效')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const renamed = await app.call('doc:rename', { ref: { path: file }, newName: '新规则' })
  expect(fs.existsSync(app.file(renamed.path))).toBe(true)
  expect(warning).toHaveBeenCalledWith('[core] 文件已移动，固定入口未更新：', expect.stringContaining('固定入口配置格式无效'))
  expect(fs.readFileSync(app.file('.jot/library-pins.json'), 'utf8')).toBe(raw)
})
