import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS } from '@shared/ipc'
import { Core } from '../../electron/core'
import { createHandlers, type Platform } from '../../electron/ipc/handlers'
import { dispatch, type Handlers } from '../../electron/ipc/register'
import { makeTmpDir, noon } from '../helpers/tmp'

const secrets = { encrypt: (s: string) => 'x:' + s, decrypt: (s: string) => s.slice(2) }
const platform: Platform = {
  appInfo: () => ({ version: 'test', dev: true, platform: 'test' }),
  trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, pickDirectory: async () => null,
  saveFile: async () => null, hideCapture: () => {},
  resizeCapture: () => {},
  openExternal: async () => {},
}

let tmp: ReturnType<typeof makeTmpDir>
let core: Core
let handlers: Handlers
let events: { event: string; data: unknown }[]
const vaultDir = () => path.join(tmp.dir, 'vault')

async function boot(): Promise<void> {
  events = []
  core = new Core({
    now: noon, userDataDir: path.join(tmp.dir, 'data'), secrets, devModel: null, emit: (event, data) => events.push({ event, data }) })
  await core.init()
  handlers = createHandlers(core, platform)
}
/** 调用一个通道，失败时让测试失败 */
async function call<K extends (typeof CHANNELS)[number]>(channel: K, args?: unknown) {
  const r = await dispatch(handlers, channel, args)
  if (!r.ok) throw new Error(`${channel} 失败：${r.error.code} ${r.error.message}`)
  return r.data
}

beforeEach(async () => {
  tmp = makeTmpDir('core')
  await boot()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await core.dispose()
  tmp.cleanup()
})

describe('记录闭环：记一条 → 保存 → 能搜到 → 能编辑', () => {
  it('每个通道都有处理函数', () => {
    expect(Object.keys(handlers).sort()).toEqual([...CHANNELS].sort())
  })

  it('没打开库时返回 VAULT_NOT_OPEN', async () => {
    const r = await dispatch(handlers, 'capture:save', { text: '想法', source: 'main-window' })
    expect(r).toMatchObject({ ok: false, error: { code: 'VAULT_NOT_OPEN' } })
  })

  it('走通整条流程', async () => {
    await call('vault:open', { path: vaultDir(), create: true })

    // 记一条
    const meta = await call('capture:save', { text: '过年回老家前要买零食', source: 'quick-capture' })
    expect(meta.path).toMatch(/^ideas\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2} \d{6}\.md$/)

    // 能搜到（两个字和三个字以上的词都行）
    for (const text of ['过年', '买零食']) {
      const found = await call('search:query', { text })
      expect(found.items.map((h) => h.doc.path)).toEqual([meta.path])
    }
    // 界面收到了通知
    expect(events.some((e) => e.event === 'vault:changed')).toBe(true)
    expect(events.some((e) => e.event === 'doc:updated' && (e.data as { path: string }).path === meta.path)).toBe(true)

    // 出现在文件列表里
    const tree = await call('vault:tree', {})
    expect(tree.find((n) => n.name === 'ideas')!.children![0]!.children![0]!.children!.map((n) => n.path)).toEqual([meta.path])

    // 按当前路径打开并编辑
    const doc = await call('doc:get', { ref: { path: meta.path } })
    expect(doc.body).toBe('过年回老家前要买零食\n')
    await call('doc:saveBody', { ref: { path: meta.path }, body: '过年回老家前要买零食和坚果\n', baseHash: doc.hash })
    expect((await call('search:query', { text: '坚果' })).total).toBe(1)

    // 用旧的指纹再保存一次：冲突
    const stale = await dispatch(handlers, 'doc:saveBody', { ref: { path: meta.path }, body: 'x', baseHash: doc.hash })
    expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  })

  it('新建笔记、改名、删除、恢复都同步到索引', async () => {
    await call('vault:open', { path: vaultDir(), create: true })
    const note = await call('doc:create', { dir: 'content', title: '读书笔记', body: '关于习惯养成的摘录' })
    expect((await call('doc:quickOpen', { query: '读书' })).map((d) => d.path)).toEqual(['content/读书笔记.md'])

    const renamed = await call('doc:rename', { ref: { path: note.path }, newName: '习惯' })
    expect((await call('search:query', { text: '习惯养成' })).items.map((h) => h.doc.path)).toEqual(['content/习惯.md'])
    expect(renamed.path).toBe('content/习惯.md')

    const { trashId } = await call('doc:delete', { ref: { path: 'content/习惯.md' } })
    expect((await call('search:query', { text: '习惯养成' })).total).toBe(0)
    await call('doc:restore', { trashId })
    expect((await call('search:query', { text: '习惯养成' })).total).toBe(1)
  })

  it('重启后直接打开上次的库；期间在外部新增、修改、删除的文件都反映到索引', async () => {
    await call('vault:open', { path: vaultDir(), create: true })
    const kept = await call('capture:save', { text: '保留的想法', source: 'main-window' })
    const gone = await call('doc:create', { dir: 'content', title: '会被删除', body: '即将消失的内容' })
    await core.dispose()

    fs.writeFileSync(path.join(vaultDir(), 'content/外部新增.md'), '在 Obsidian 里写的笔记')
    fs.unlinkSync(path.join(vaultDir(), gone.path))
    const keptFile = path.join(vaultDir(), kept.path)
    fs.writeFileSync(keptFile, fs.readFileSync(keptFile, 'utf8').replace('保留的想法', '改过的想法'))

    await boot()
    expect((await call('vault:status')).open).toBe(true)
    expect((await call('search:query', { text: 'Obsidian' })).items.map((h) => h.doc.path)).toEqual(['content/外部新增.md'])
    expect((await call('search:query', { text: '即将消失' })).total).toBe(0)
    expect((await call('search:query', { text: '改过的想法' })).items.map((h) => h.doc.path)).toEqual([kept.path])
  })

  it('索引丢失后可以从文件重建', async () => {
    await call('vault:open', { path: vaultDir(), create: true })
    await call('capture:save', { text: '第一条想法', source: 'main-window' })
    await call('doc:create', { dir: 'content', title: '笔记', body: '笔记内容' })
    await core.dispose()
    for (const f of fs.readdirSync(path.join(vaultDir(), '.jot'))) {
      if (f.startsWith('index.db')) fs.unlinkSync(path.join(vaultDir(), '.jot', f))
    }
    await boot()
    expect((await call('search:query', {})).total).toBe(2)
    // 显式重建的结果相同
    expect(await core.syncIndex(true)).toEqual({ indexed: 2, removed: 0 })
  })

  it('重建发现旧目录时明确拒绝，保留已有索引和用户文件', async () => {
    await call('vault:open', { path: vaultDir(), create: true })
    const note = await call('doc:create', { title: '已保存', body: '当前内容' })
    const old = path.join(vaultDir(), 'notes/旧笔记.md')
    fs.mkdirSync(path.dirname(old), { recursive: true })
    fs.writeFileSync(old, '待手动整理的旧内容')
    expect(await dispatch(handlers, 'vault:rebuildIndex', undefined)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(core.index.getDoc(note.path)?.path).toBe(note.path)
    expect(fs.readFileSync(old, 'utf8')).toBe('待手动整理的旧内容')
  })

  it('不支持正文的原件可按文件名搜索，仍不伪造正文证据', async () => {
    await call('vault:open', { path: vaultDir(), create: true })
    fs.writeFileSync(path.join(vaultDir(), 'content/a.pdf'), Buffer.from([1, 2, 3]))
    await core.syncIndex()
    expect((await call('search:query', { text: 'a.pdf' }))).toMatchObject({ total: 1, items: [{ chunk: { chunkId: '', text: '' } }] })
    const tree = await call('vault:tree', {})
    expect(tree.find((n) => n.name === 'content')!.children!.filter(n => n.kind === 'file').map((n) => n.name)).toEqual(['a.pdf'])
  })
})

describe('清单同步后的界面通知', () => {
  it('全库刷新通知正文与删除变化；仅空目录变化也刷新逻辑侧栏', async () => {
    vi.spyOn(core.vault, 'startWatching').mockImplementation(() => {})
    await call('vault:open', { path: vaultDir(), create: true })
    const first = path.join(vaultDir(), 'content/笔记.md')
    fs.writeFileSync(first, '第一版')
    await core.syncIndex()
    events.length = 0
    fs.writeFileSync(first, '外部修改后的正文')
    await core.syncIndex()
    expect(events).toEqual(expect.arrayContaining([
      { event: 'vault:changed', data: { changes: expect.arrayContaining([{ path: 'content/笔记.md', kind: 'change' }]) } },
      { event: 'files:changed', data: null },
    ]))
    events.length = 0
    fs.unlinkSync(first)
    await core.syncIndex()
    expect(events).toContainEqual({ event: 'vault:changed', data: { changes: expect.arrayContaining([{ path: 'content/笔记.md', kind: 'remove' }]) } })
    events.length = 0
    fs.mkdirSync(path.join(vaultDir(), 'content/新建空目录'))
    expect(await core.syncIndex()).toEqual({ indexed: 0, removed: 0 })
    expect(events).toContainEqual({ event: 'files:changed', data: null })
    expect(events).toContainEqual({ event: 'vault:changed', data: { changes: [{ path: 'content', kind: 'change' }] } })
  })

  it('原文未变时仍通知附属属性变化；重建后界面可回读当前资料', async () => {
    vi.spyOn(core.vault, 'startWatching').mockImplementation(() => {})
    await call('vault:open', { path: vaultDir(), create: true })
    const source = path.join(vaultDir(), 'content/资料.txt')
    fs.writeFileSync(source, '原文保持')
    await core.syncIndex()
    events.length = 0
    fs.writeFileSync(source + '.meta.yaml', 'kind: attachment\ntags: [更新属性]\n')
    expect(await core.syncIndex()).toEqual({ indexed: 1, removed: 0 })
    expect(events).toContainEqual({ event: 'files:changed', data: null })
    expect(core.index.getDoc('content/资料.txt')?.classification.tags).toEqual(['更新属性'])
    events.length = 0
    expect(await core.syncIndex(true)).toEqual({ indexed: 1, removed: 0 })
    expect(events).toContainEqual({ event: 'files:changed', data: null })
    expect(fs.readFileSync(source, 'utf8')).toBe('原文保持')
  })

  it('摘要读取按当前磁盘反馈来源缺失与恢复，不依赖旧索引标记', async () => {
    vi.spyOn(core.vault, 'startWatching').mockImplementation(() => {})
    await call('vault:open', { path: vaultDir(), create: true })
    const source = path.join(vaultDir(), 'content/原件.txt')
    const summary = 'wiki/sources/来源摘要.md'
    fs.writeFileSync(path.join(vaultDir(), summary), '---\ntype: source-summary\nsource: content/原件.txt\n---\n可读摘要')
    expect(await call('doc:get', { ref: { path: summary } })).toMatchObject({ sourceMissing: true, body: '可读摘要' })
    fs.writeFileSync(source, '恢复原件')
    expect(await call('doc:get', { ref: { path: summary } })).toMatchObject({ sourceMissing: false, sourcePath: 'content/原件.txt' })
    fs.unlinkSync(source)
    expect(await call('doc:get', { ref: { path: summary } })).toMatchObject({ sourceMissing: true })
  })
})
