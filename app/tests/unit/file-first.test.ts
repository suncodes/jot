import { modelSettings } from '../helpers/models'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Args, Ret } from '@shared/ipc'
import { Core } from '../../electron/core'
import { createHandlers } from '../../electron/ipc/handlers'
import { dispatch, type Handlers } from '../../electron/ipc/register'
import { parseDoc } from '../../electron/vault/frontmatter'
import { startFakeLlm } from '../helpers/fake-llm'
import { makeTmpDir } from '../helpers/tmp'

let tmp: ReturnType<typeof makeTmpDir>
let core: Core
let handlers: Handlers
const raw = (rel: string) => fs.readFileSync(core.vault.abs(rel), 'utf8')
const write = (rel: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(core.vault.abs(rel)), { recursive: true })
  fs.writeFileSync(core.vault.abs(rel), text)
}
async function call<K extends Channel>(channel: K, args: Args<K>): Promise<Ret<K>> {
  const result = await dispatch(handlers, channel, args)
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message)
  return result.data
}
const open = (rel: string) => call('doc:get', { ref: { path: rel } })
beforeEach(async () => {
  tmp = makeTmpDir('r1-files')
  core = new Core({ now: () => new Date('2026-11-19T12:00:00+08:00'), userDataDir: path.join(tmp.dir, 'user'),
    secrets: { encrypt: value => 'test:' + value, decrypt: value => value.slice(5) }, devModel: null, emit: () => {} })
  await core.init()
  await core.settings.set({ classify: { enabled: false }, daily: { enabled: false } })
  await core.openVault(path.join(tmp.dir, 'vault'), true)
  handlers = createHandlers(core, { appInfo: () => ({ version: 'test', dev: true, platform: 'test' }), trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, pickDirectory: async () => null,
    saveFile: async () => null, hideCapture: () => {}, resizeCapture: () => {}, openExternal: async () => {} })
})
afterEach(async () => { vi.restoreAllMocks(); await core.dispose(); tmp.cleanup() })

describe('R1 文件与属性权威', () => {
  it('无头部／重复旧 ID 可直接读取，新笔记和随手记不补 ID', async () => {
    write('content/工作/外部.md', '# 原文\n无需登记')
    write('content/工作/甲.md', '---\nid: same\n---\n甲')
    write('content/工作/乙.md', '---\nid: same\n---\n乙')
    await core.syncIndex()
    expect((await open('content/工作/外部.md')).body).toBe('# 原文\n无需登记')
    expect((await open('content/工作/甲.md')).body).toBe('甲')
    expect((await open('content/工作/乙.md')).body).toBe('乙')
    const note = await core.vault.createNote({ title: '新笔记' })
    const idea = await core.vault.createIdea({ text: '新想法', source: 'main-window' })
    expect(parseDoc(raw(note.path)).data).not.toHaveProperty('id')
    expect(parseDoc(raw(idea.path)).data).not.toHaveProperty('id')
    expect(raw('content/工作/外部.md')).toBe('# 原文\n无需登记')
    core.index.close()
    expect((await open('content/工作/外部.md')).body).toContain('无需登记')
  })

  it('属性补丁保留未知空值、数组和普通旧 ID；只改变指定键', async () => {
    write('content/属性.md', '---\nid: old\ncustom_null: null\ncustom_empty: ""\ncustom: [甲, 乙]\ntags: [旧]\n---\n正文不变')
    await call('doc:patchProperties', { path: 'content/属性.md', patch: { tags: ['新'], place: '北京' } })
    const parsed = parseDoc(raw('content/属性.md'))
    expect(parsed.data).toMatchObject({ id: 'old', custom_null: null, custom_empty: '', custom: ['甲', '乙'], tags: ['新'], place: '北京' })
    expect(parsed.body).toBe('正文不变')
    await call('doc:patchProperties', { path: 'content/属性.md', patch: { place: null, tags: [] } })
    expect(parseDoc(raw('content/属性.md')).data).not.toHaveProperty('place')
    expect((await open('content/属性.md')).classification.tags).toEqual([])
  })

  it.each(['---\n[甲, 乙]\n---\n正文', '---\ntags: [未闭合\n---\n正文'])('非法 YAML 对象可读但不能被属性写入清空', async text => {
    write('content/无效.md', text)
    expect((await open('content/无效.md')).body).toBe('正文')
    await expect(call('doc:patchProperties', { path: 'content/无效.md', patch: { tags: ['新'] } })).rejects.toThrow('INVALID_INPUT')
    expect(raw('content/无效.md')).toBe(text)
  })

  it('导入 Markdown 保持原字节，sidecar 用途和属性优先，原文可按明确操作编辑', async () => {
    const imported = path.join(tmp.dir, '资料.md')
    const source = Buffer.from('\ufeff---\r\ntype: daily\r\ntags: [原件标签]\r\n---\r\n原文\r\n')
    fs.writeFileSync(imported, source)
    const result = await core.vault.importFile(imported, 'content/工作')
    await core.idle()
    expect(fs.readFileSync(core.vault.abs(result.path))).toEqual(source)
    const doc = await open(result.path)
    expect(doc).toMatchObject({ type: 'file', editable: true, bodyStartLine: 1, classification: { tags: [] } })
    expect(doc.body).toBe(source.toString('utf8'))
    await call('doc:patchProperties', { path: result.path, patch: { tags: ['资料'], related: ['content/工作'] } })
    expect(fs.readFileSync(core.vault.abs(result.path))).toEqual(source)
    expect(yaml.load(raw(result.path + '.meta.yaml'))).toMatchObject({ kind: 'attachment', tags: ['资料'], related: ['content/工作'] })
    expect((await call('library:query', {})).items.map(item => item.path)).toEqual([result.path])
    await call('doc:editText', { path: result.path, before: '原文', after: '明确修改的原文' })
    expect(raw(result.path)).toContain('明确修改的原文')
  })

  it('无效附属文件不被覆盖，也不能让原件伪装成日总结', async () => {
    write('content/导入.md', '---\ntype: daily\n---\n原件')
    write('content/导入.md.meta.yaml', 'kind: [')
    expect((await open('content/导入.md')).type).toBe('file')
    await expect(call('doc:patchProperties', { path: 'content/导入.md', patch: { tags: ['新'] } })).rejects.toThrow('INVALID_INPUT')
    expect(raw('content/导入.md.meta.yaml')).toBe('kind: [')
  })

  it('局部编辑要求当前原文唯一匹配，失败保持磁盘内容', async () => {
    write('content/编辑.txt', '甲 甲 乙')
    await expect(call('doc:editText', { path: 'content/编辑.txt', before: '甲', after: '丙' })).rejects.toThrow('CONFLICT')
    await expect(call('doc:editText', { path: 'content/编辑.txt', before: '不存在', after: '丙' })).rejects.toThrow('CONFLICT')
    expect(raw('content/编辑.txt')).toBe('甲 甲 乙')
    await call('doc:editText', { path: 'content/编辑.txt', before: '乙', after: '丙' })
    expect(raw('content/编辑.txt')).toBe('甲 甲 丙')
  })
})

describe('R1 增量索引和独立文件', () => {
  it('普通刷新只枚举；属性附属文件新增、编辑、删除都独立触发附件重解析', async () => {
    write('content/清单.txt', '接口甲')
    await core.syncIndex()
    const read = vi.spyOn(core.vault, 'readRaw')
    await core.syncIndex()
    expect(read).not.toHaveBeenCalled()
    write('content/清单.txt.meta.yaml', 'kind: attachment\ntags: [接口]\n')
    await call('vault:refreshIndex', {})
    expect((await call('taxonomy:terms', { kind: 'tag' })).map(term => term.name)).toContain('接口')
    write('content/清单.txt.meta.yaml', 'kind: attachment\ntags: [业务规则]\n')
    await call('vault:refreshIndex', { paths: ['content/清单.txt.meta.yaml'] })
    expect((await call('search:query', { filter: { tags: ['业务规则'] } })).total).toBe(1)
    fs.unlinkSync(core.vault.abs('content/清单.txt.meta.yaml'))
    await core.syncIndex()
    expect((await call('taxonomy:terms', { kind: 'tag' })).map(term => term.name)).not.toContain('业务规则')
    expect((await core.vault.listFiles()).map(file => file.path)).toEqual(['content/清单.txt'])
    expect(core.jobs.list({}).total).toBe(0)
  })

  it('附件／摘要按 source 合并；同内容副本独立，重建能恢复标签、关联和配对', async () => {
    write('content/工作/资料.txt', '相同内容')
    write('content/工作/副本.txt', '相同内容')
    write('content/工作/资料.txt.meta.yaml', 'kind: attachment\ntags: [需求]\nrelated: [content/学习]\n')
    write('wiki/sources/资料.md', '---\ntype: source-summary\nsource: content/工作/资料.txt\n---\n摘要内容')
    write('inbox/想法.md', '---\ntype: idea\nrelated: [content/工作]\n---\n跨目录记录')
    await core.vault.createFolder('content', '学习')
    await core.syncIndex()
    const before = await call('library:query', {})
    expect(before.total).toBe(3)
    expect(before.items.find(item => item.path === 'content/工作/资料.txt')?.summaryPath).toBe('wiki/sources/资料.md')
    const conversation = core.agent.create()
    await core.syncIndex(true)
    expect((await call('library:query', {})).total).toBe(3)
    expect((await call('taxonomy:terms', { kind: 'tag' }))).toMatchObject([{ name: '需求', count: 1 }])
    expect(await call('links:list', { path: 'inbox/想法.md' })).toEqual([])
    expect(core.agent.get(conversation.conversationId).info.conversationId).toBe(conversation.conversationId)
  })

  it('空目录直接可见；不支持正文的附件也可管理、索引属性而不调用模型', async () => {
    await core.vault.createFolder('content/工作', '空目录')
    write('content/工作/附件.pdf', Buffer.from([0, 1, 2, 3]))
    write('content/工作/附件.pdf.meta.yaml', 'kind: attachment\ntags: [合同]\n')
    await core.syncIndex()
    expect((await core.vault.directories('content/工作')).map(dir => dir.path)).toContain('content/工作/空目录')
    expect((await call('search:query', { filter: { tags: ['合同'] } })).total).toBe(1)
    expect((await open('content/工作/附件.pdf')).editable).toBe(false)
    expect(core.jobs.list({}).total).toBe(0)
  })

  it('仅修改文件、发现外部待整理记录和重建都不会安排模型任务', async () => {
    await core.settings.set({ classify: { enabled: true } })
    write('inbox/外部.md', '---\ntype: idea\nstatus: 待整理\n---\n外部文件')
    write('content/资料.txt', '外部资料')
    await core.syncIndex()
    write('content/资料.txt', '外部更新资料')
    await core.refreshIndex(['content/资料.txt', 'inbox/外部.md'])
    await core.syncIndex(true)
    expect(core.jobs.list({}).total).toBe(0)
  })
})

describe('R1 路径移动、回收和链接', () => {
  it('改名携带 sidecar，并维护正文及摘要来源；代码块和别名锚点保留', async () => {
    write('content/工作/资料.txt', '原件')
    write('content/工作/资料.txt.meta.yaml', 'kind: attachment\ntags: [需求]\n')
    write('content/引用.md', '[资料](工作/资料.txt#字段 "标题")\n`[示例](工作/资料.txt)`\n~~~md\n[示例](工作/资料.txt)\n~~~\n[[content/工作/资料.txt|原件]]')
    write('wiki/sources/资料.md', '---\ntype: source-summary\nsource: content/工作/资料.txt\n---\n[原件](../../content/工作/资料.txt)')
    await core.syncIndex()
    const changed = await call('content:move', { path: 'content/工作/资料.txt', targetPath: 'content/工作/新版.txt' })
    expect(changed.notUpdated).toEqual([])
    expect(changed.paths.map(item => item.to)).toContain('content/工作/新版.txt.meta.yaml')
    expect(raw('content/工作/新版.txt.meta.yaml')).toContain('需求')
    expect(raw('content/引用.md')).toContain('[资料](' + encodeURI('工作/新版.txt') + '#字段 "标题")')
    expect(raw('content/引用.md')).toContain('`[示例](工作/资料.txt)`')
    expect(raw('content/引用.md')).toContain('[示例](工作/资料.txt)\n~~~')
    expect(raw('content/引用.md')).toContain('[[content/工作/新版.txt|原件]]')
    expect(parseDoc(raw('wiki/sources/资料.md')).data.source).toBe('content/工作/新版.txt')
  })

  it('移动目录维护自身相对链接、正文链接；旧 related 作为普通属性保留', async () => {
    write('content/工作/A/笔记.md', '[外部](../规则.md)\n[内部](资料.txt)')
    write('content/工作/A/资料.txt', '附件')
    write('content/工作/规则.md', '规则')
    write('inbox/记录.md', '---\ntype: idea\nrelated: [content/工作/A]\n---\n记录')
    await core.vault.createFolder('content/工作/A', '空目录')
    await core.syncIndex()
    await call('content:move', { path: 'content/工作/A', targetPath: 'content/A' })
    expect(raw('content/A/笔记.md')).toContain('[外部](' + encodeURI('../工作/规则.md') + ')')
    expect(parseDoc(raw('inbox/记录.md')).data.related).toEqual(['content/工作/A'])
    expect((await core.vault.directories('content/A')).map(dir => dir.name)).toContain('空目录')
  })

  it('附件组重名不覆盖；回收恢复按同一新名称配对附属文件', async () => {
    write('content/资料.txt', '原件')
    write('content/资料.txt.meta.yaml', 'kind: attachment\ntags: [资料]\n')
    write('content/目标.txt.meta.yaml', 'kind: attachment\ntags: [占位]\n')
    await expect(call('content:move', { path: 'content/资料.txt', targetPath: 'content/目标.txt' })).rejects.toThrow('CONFLICT')
    expect(raw('content/资料.txt')).toBe('原件')
    const trashed = await core.vault.trash({ path: 'content/资料.txt' })
    write('content/资料.txt', '占位')
    const restored = await core.vault.restoreGroup(trashed.trashId)
    expect(restored.doc.path).toBe('content/资料 2.txt')
    expect(raw('content/资料 2.txt.meta.yaml')).toContain('资料')
    expect(raw('content/资料.txt')).toBe('占位')
  })

  it('目标删除保留断链，来源删除移除出链；外部重建同一路径读取当前内容', async () => {
    write('content/引用.md', '[资料](资料.md)')
    write('content/资料.md', '第一份')
    await core.syncIndex()
    fs.unlinkSync(core.vault.abs('content/资料.md'))
    await core.syncIndex()
    const broken = await call('links:list', { path: 'content/引用.md' })
    expect(broken).toMatchObject([{ missing: true, kind: 'markdown' }])
    expect(raw('content/引用.md')).toBe('[资料](资料.md)')
    write('content/资料.md', '新文件')
    expect((await open((await call('doc:resolveLink', { from: 'content/引用.md', target: '资料.md', kind: 'markdown' })).path)).body).toBe('新文件')
    fs.unlinkSync(core.vault.abs('content/引用.md'))
    await core.syncIndex()
    expect(await call('links:list', { path: 'content/引用.md' })).toEqual([])
  })

  it('部分链接维护失败返回未更新项，已完成的移动如实保留', async () => {
    write('content/引用.md', '[资料](资料.md)')
    write('content/资料.md', '原文')
    await core.syncIndex()
    const save = core.vault.saveBody.bind(core.vault)
    vi.spyOn(core.vault, 'saveBody').mockImplementation((ref, body, hash, actor) => 'path' in ref && ref.path === 'content/引用.md'
      ? Promise.reject(new Error('模拟文件占用')) : save(ref, body, hash, actor))
    const changed = await call('content:move', { path: 'content/资料.md', targetPath: 'content/新版.md' })
    expect(changed.notUpdated).toMatchObject([{ path: 'content/引用.md', message: '模拟文件占用' }])
    expect(raw('content/新版.md')).toBe('原文')
    expect(fs.existsSync(core.vault.abs('content/资料.md'))).toBe(false)
  })
})

describe('R1 范围与边界回归', () => {
  it('目录只查物理子树，旧 related 字段不扩散', async () => {
    write('content/工作/A/规则.md', '规则')
    write('inbox/第一跳.md', '---\ntype: idea\nrelated: [content/工作/A]\n---\n第一跳')
    write('inbox/第二跳.md', '---\ntype: idea\nrelated: [inbox/第一跳.md]\n---\n第二跳')
    await core.syncIndex()
    const scope = { selection: { kind: 'directory' as const, path: 'content/工作/A', recursive: true } }
    expect((await call('library:query', { scope })).items.map(item => item.path).sort()).toEqual(['content/工作/A/规则.md'])
    expect((await call('search:query', { filter: { scope } })).items.map(item => item.doc.path).sort()).toEqual(['content/工作/A/规则.md'])
  })

  it('单路径刷新不全库枚举正文，清单只更新指定子树', async () => {
    write('content/工作/甲.md', '甲')
    write('content/生活/乙.md', '乙')
    await core.syncIndex()
    const list = vi.spyOn(core.vault, 'listFiles')
    const read = vi.spyOn(core.vault, 'readRaw')
    write('content/工作/甲.md', '甲更新')
    const changed = await core.refreshIndex(['content/工作/甲.md'])
    expect(changed).toEqual({ indexed: 1, removed: 0 })
    expect(list).not.toHaveBeenCalled()
    expect(read.mock.calls.every(([rel]) => rel === 'content/工作/甲.md')).toBe(true)
    fs.unlinkSync(core.vault.abs('content/工作/甲.md'))
    expect(await core.refreshIndex(['content/工作/甲.md'])).toEqual({ indexed: 0, removed: 1 })
    expect(core.index.getDoc('content/生活/乙.md')).not.toBeNull()
  })

  it('回收目录后重名恢复，内部相对链接保留，外部新占位对象的链接不转移', async () => {
    write('content/工作/A/甲.md', '[乙](乙.md)\n[外部](../规则.md)')
    write('content/工作/A/乙.md', '乙')
    write('content/工作/规则.md', '规则')
    await core.syncIndex()
    const deleted = await core.vault.trashFolder('content/工作/A')
    write('content/工作/A/占位.md', '占位')
    write('content/引用.md', '[占位](工作/A/占位.md)')
    const restored = await core.vault.restoreFolder(deleted.trashId)
    expect(restored.path).toBe('content/工作/A 2')
    expect(raw('content/工作/A 2/甲.md')).toContain('[乙](乙.md)')
    expect(raw('content/引用.md')).toBe('[占位](工作/A/占位.md)')
    expect(restored.notUpdated).toEqual([])
  })

  it('目标路径越界和附属属性直写被拒绝，库外 junction 不允许打开', async () => {
    write('content/安全.md', '内容')
    for (const rel of ['../outside.md', '.jot/state.db', 'content/安全.md.meta.yaml']) {
      await expect(core.vault.read({ path: rel })).rejects.toBeTruthy()
    }
    const outside = path.join(tmp.dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, '资料.md'), '库外资料')
    fs.symlinkSync(outside, path.join(core.vault.path, 'content', '跳转'), 'junction')
    await expect(open('content/跳转/资料.md')).rejects.toThrow('符号链接指向库外')
    expect(() => core.refreshIndex(['.jot/state.db'])).toThrow('不能索引软件数据目录')
    await expect(core.vault.tree('.jot')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' })
  })

  it('旧格式库明确阻止混用，不修改配置、正文或应用状态', async () => {
    const legacy = path.join(tmp.dir, 'old-vault')
    fs.mkdirSync(path.join(legacy, '.jot'), { recursive: true })
    fs.writeFileSync(path.join(legacy, '.jot/config.json'), '{"version":2}')
    fs.writeFileSync(path.join(legacy, '保留.md'), '旧用户文件')
    const vault = new (core.vault.constructor as new () => typeof core.vault)()
    await expect(vault.open(legacy, false)).rejects.toThrow('旧存储格式')
    expect(fs.readFileSync(path.join(legacy, '.jot/config.json'), 'utf8')).toBe('{"version":2}')
    expect(fs.readFileSync(path.join(legacy, '保留.md'), 'utf8')).toBe('旧用户文件')
    await vault.close()
  })

  it('无当前索引仍可保存正文，属性变化不会被旧原文比较误覆盖', async () => {
    write('content/编辑.md', '---\ntags: [原标签]\n---\n原正文')
    await core.syncIndex()
    core.index.close()
    await core.vault.patchFrontmatter({ path: 'content/编辑.md' }, { tags: ['新标签'] }, 'user')
    await core.vault.saveCurrentBody('content/编辑.md', '新正文', '原正文')
    expect(parseDoc(raw('content/编辑.md'))).toMatchObject({ data: { tags: ['新标签'] }, body: '新正文' })
    await expect(core.vault.saveCurrentBody('content/编辑.md', '覆盖', '原正文')).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('标签改名同时写笔记和附件属性，原件字节保持，重建后计数不变', async () => {
    write('content/笔记.md', '---\ntags: [旧标签]\n---\n正文')
    write('content/附件.txt', '原文')
    write('content/附件.txt.meta.yaml', 'kind: attachment\ntags: [旧标签]\n')
    await core.syncIndex()
    expect(await call('taxonomy:rename', { kind: 'tag', from: '旧标签', to: '新标签' })).toMatchObject({ affected: 2, failed: [] })
    expect(raw('content/附件.txt')).toBe('原文')
    expect(yaml.load(raw('content/附件.txt.meta.yaml'))).toMatchObject({ tags: ['新标签'] })
    await core.syncIndex(true)
    expect(await call('taxonomy:terms', { kind: 'tag' })).toMatchObject([{ name: '新标签', count: 2 }])
  })
})

describe('R1 导入任务联动', () => {
  it('明确导入调用本地假模型，摘要用普通 source 配对；后续资料修改不覆盖旧摘要', async () => {
    const fake = await startFakeLlm(() => JSON.stringify({ oneLine: '一份接口说明', points: ['约定接口字段'], entities: {} }))
    try {
      await core.settings.set({ ...modelSettings({ baseUrl: fake.baseUrl, apiKey: 'fake', model: 'fake-model' }, core.settings.get()) })
      const outside = path.join(tmp.dir, '接口.txt')
      fs.writeFileSync(outside, '第一版接口')
      const imported = await call('files:import', { paths: [outside], toDir: 'content/工作' })
      await core.quiesce()
      expect(imported.skipped).toEqual([])
      const item = (await call('library:query', {})).items.find(entry => entry.path === imported.imported[0])!
      expect(item.summaryPath).toBeTruthy()
      const summary = parseDoc(raw(item.summaryPath!))
      expect(summary.data.source).toBe(imported.imported[0])
      expect(summary.data).not.toHaveProperty('id')
      const count = fake.requests.length
      const originalSummary = raw(item.summaryPath!)
      write(imported.imported[0]!, '第二版接口，外部改动')
      await core.refreshIndex([imported.imported[0]!])
      await core.quiesce()
      expect(raw(item.summaryPath!)).toBe(originalSummary)
      expect(fake.requests.length).toBe(count)
      await expect(call('files:reprocess', { path: imported.imported[0]! })).rejects.toThrow('CONFLICT')
    } finally { await core.jobs.stop(); await fake.close() }
  })

  it('显式捕获只产生属性建议，确认前不写文件或目录关联', async () => {
    const fake = await startFakeLlm(() => JSON.stringify({ directoryPath: 'content/工作', tags: ['工作想法'],
      place: null, people: [], confidence: 0.95, reason: '内容属于工作' }))
    try {
      await core.settings.set({ classify: { enabled: true }, ...modelSettings({ baseUrl: fake.baseUrl, apiKey: 'fake', model: 'fake-model' }, core.settings.get()) })
      const record = await call('capture:save', { text: '整理接口字段', source: 'main-window' })
      await core.quiesce()
      expect(parseDoc(raw(record.path)).data).not.toHaveProperty('tags')
      expect(core.state.getSuggestions(record.path)).toEqual([expect.objectContaining({ kind: 'properties', properties: { tags: ['工作想法'] } })])
      expect(parseDoc(raw(record.path)).data).not.toHaveProperty('id')
    } finally { await core.jobs.stop(); await fake.close() }
  })
})
