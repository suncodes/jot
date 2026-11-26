import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testApp } from '../helpers/test-app'
import { parseDoc } from '../../electron/vault/frontmatter'
import { buildSystemPrompt } from '../../electron/agent/service'
import { agentScript } from '../helpers/fake-llm'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp(); app.clock('2026-11-30T23:59:00+08:00') })
afterEach(async () => { await app.close() })
const raw = (rel: string) => fs.readFileSync(app.file(rel), 'utf8')
const source = (name: string) => {
  const absolute = path.join(app.tmp.dir, name)
  fs.writeFileSync(absolute, '---\ntags: [原稿]\n---\n虚构资料正文')
  return absolute
}
const trashDir = (month: string, id: string) => app.file('.jot/trash/' + month + '/' + id)

describe('R7 新内容落点与年月分层', () => {
  it('无目录笔记进入当月 inbox，明确目录和显式根目标照常使用', async () => {
    const pending = await app.call('doc:create', { title: '无目录', body: '新资料' })
    const selected = await app.call('doc:create', { dir: 'content/工作', title: '规则' })
    const explicitRoot = await app.call('doc:create', { dir: 'content', title: '明确根目录' })
    expect(pending.path).toBe('inbox/2026/11/无目录.md')
    expect(selected.path).toBe('content/工作/规则.md')
    expect(explicitRoot.path).toBe('content/明确根目录.md')
    expect(app.core.classify.inbox({}).items.map(item => item.doc.path)).toEqual([pending.path])
    expect(parseDoc(raw(pending.path)).data).not.toHaveProperty('status')
    app.clock('2026-12-01T00:01:00+08:00')
    const next = await app.call('doc:create', { title: '无目录' })
    expect(next.path).toBe('inbox/2026/12/无目录.md')
    await app.core.vault.saveCurrentBody(pending.path, '下月继续编辑')
    await app.core.idle()
    expect(raw(pending.path)).toContain('下月继续编辑')
    expect((await app.call('library:query', {})).total).toBe(4)
  })

  it('无目录导入使用 inbox 年月，保持 Markdown 原字节及同组属性，不覆盖重名', async () => {
    const external = source('资料.md'), original = fs.readFileSync(external)
    const first = await app.call('files:import', { paths: [external] })
    const second = await app.call('files:import', { paths: [external] })
    const explicit = await app.call('files:import', { paths: [external], toDir: 'content/工作' })
    expect(first).toEqual({ imported: ['inbox/2026/11/资料.md'], skipped: [] })
    expect(second.imported).toEqual(['inbox/2026/11/资料 2.md'])
    expect(explicit.imported).toEqual(['content/工作/资料.md'])
    expect(fs.readFileSync(app.file(first.imported[0]!))).toEqual(original)
    const metadata = await app.core.vault.getProperties(first.imported[0]!)
    expect(metadata).toMatchObject({ attachment: true, data: { kind: 'attachment', created: '2026-11-30T23:59:00+08:00' } })
    expect(metadata.data).not.toHaveProperty('status')
    expect(app.core.classify.inbox({}).total).toBe(2)
    expect(app.fake.requests).toHaveLength(0)
  })

  it('灵感按记录月、补记按发生月；跨月编辑起止日期不搬动原文件', async () => {
    const idea = await app.call('capture:save', { text: '灵感', source: 'main-window' })
    const log = await app.call('capture:saveLog', { text: '月末补记', start: '2026-10-31', end: '2026-11-01' })
    expect(idea.path).toMatch(/^ideas\/2026\/11\//)
    expect(log.path).toBe('ideas/2026/10/2026-10-31.md')
    expect(log.created).toBe('2026-11-30T23:59:00+08:00')
    await app.call('doc:setLogTime', { ref: { path: log.path }, start: '2026-12-01', end: '2026-12-01' })
    expect(fs.existsSync(app.file(log.path))).toBe(true)
    expect(fs.existsSync(app.file('ideas/2026/12/2026-10-31.md'))).toBe(false)
    await app.reopen({ removeIndex: true })
    expect(app.core.classify.inbox({}).total).toBe(0)
    expect((await app.call('library:query', { scope: { selection: { kind: 'collection', name: 'ideas' } } })).total).toBe(2)
  })

  it('摘要首次生成落当前年月，跨月重做沿用原路径并保持普通来源链接', async () => {
    app.write('content/工作/资料.txt', '虚构原件')
    await app.core.syncIndex()
    await app.core.files.summarize('content/工作/资料.txt')
    const summary = app.core.files.summaries('content/工作/资料.txt')[0]!
    expect(summary).toBe('wiki/sources/2026/11/资料.md')
    const link = (await app.call('links:list', { path: summary })).find(link => link.kind === 'markdown')!
    expect(link.path).toBe('content/工作/资料.txt')
    expect(raw(summary)).toContain('../../../../content/')
    app.clock('2026-12-01T00:01:00+08:00')
    await app.core.files.summarize('content/工作/资料.txt', { force: true })
    expect(app.core.files.summaries('content/工作/资料.txt')).toEqual([summary])
    expect(parseDoc(raw(summary)).data).toMatchObject({ created: '2026-11-30T23:59:00+08:00', generated_at: '2026-12-01T00:01:00+08:00' })
    app.write('content/生活/资料.txt', '另一份原件')
    await app.core.syncIndex()
    await app.core.files.summarize('content/生活/资料.txt')
    expect(app.core.files.summaries('content/生活/资料.txt')).toEqual(['wiki/sources/2026/12/资料.md'])
    await app.reopen({ removeIndex: true })
    expect(app.core.files.summaries('content/工作/资料.txt')).toEqual([summary])
  })

  it('现有平铺或用户移动的摘要主动重做保留指定位置，不补造年月副本', async () => {
    app.write('content/工作/资料.txt', '原件')
    app.write('wiki/sources/既有摘要.md', '---\ntype: source-summary\nsource: content/工作/资料.txt\n---\n旧摘要')
    await app.core.syncIndex()
    await app.core.files.summarize('content/工作/资料.txt', { force: true })
    expect(app.core.files.summaries('content/工作/资料.txt')).toEqual(['wiki/sources/既有摘要.md'])
    expect(fs.existsSync(app.file('wiki/sources/2026'))).toBe(false)
  })

  it('回收按删除月分层，跨月和重启后按编号恢复附件组，保留同名占位', async () => {
    const imported = await app.call('files:import', { paths: [source('附件.md')] })
    const file = imported.imported[0]!
    const first = await app.call('library:delete', { path: file, scope: 'entry' })
    expect(fs.existsSync(path.join(trashDir('2026/11', first.trashId), 'meta.json'))).toBe(true)
    expect(fs.readdirSync(trashDir('2026/11', first.trashId))).toHaveLength(3)
    app.clock('2026-12-01T00:01:00+08:00')
    const note = await app.call('doc:create', { title: '下月笔记' })
    const second = await app.call('doc:delete', { ref: { path: note.path } })
    expect(fs.existsSync(trashDir('2026/12', second.trashId))).toBe(true)
    await app.reopen({ removeIndex: true })
    expect((await app.call('trash:list', { limit: 1 })).items[0]?.trashId).toBe(second.trashId)
    expect((await app.call('trash:list', { limit: 1, offset: 1 })).items[0]?.trashId).toBe(first.trashId)
    app.write(file, '新占位')
    const restored = await app.call('doc:restore', first)
    expect(restored.path).toBe('inbox/2026/11/附件 2.md')
    expect(raw(file)).toBe('新占位')
    expect((await app.core.vault.getProperties(restored.path)).attachment).toBe(true)
    expect(raw(restored.path)).toContain('虚构资料正文')
    expect(fs.existsSync(trashDir('2026/11', first.trashId))).toBe(false)
    await app.call('trash:purge', { trashIds: [second.trashId] })
    expect((await app.call('trash:list', {})).total).toBe(0)
  })

  it('目录与摘要一组回收，跨年恢复保留空目录和摘要来源', async () => {
    app.write('content/工作/项目/资料.txt', '原件')
    fs.mkdirSync(app.file('content/工作/项目/空目录'), { recursive: true })
    await app.core.syncIndex()
    await app.core.files.summarize('content/工作/项目/资料.txt')
    const summary = app.core.files.summaries('content/工作/项目/资料.txt')[0]!
    const trash = await app.call('folder:delete', { path: 'content/工作/项目' })
    expect((await app.call('trash:list', {})).items[0]).toMatchObject({ kind: 'directory', trashId: trash.trashId })
    expect(fs.existsSync(app.file(summary))).toBe(false)
    app.clock('2027-01-01T10:00:00+08:00')
    await app.reopen({ removeIndex: true })
    await app.call('folder:restore', trash)
    expect(fs.statSync(app.file('content/工作/项目/空目录')).isDirectory()).toBe(true)
    expect(app.core.files.summaries('content/工作/项目/资料.txt')).toEqual([summary])
  })

  it('清理只删除明确编号，非法或重复编号不删除其他内容', async () => {
    const note = await app.call('doc:create', { title: '保留回收项' })
    const trash = await app.call('doc:delete', { ref: { path: note.path } })
    await expect(app.core.vault.purgeTrash([trash.trashId, '../outside'])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(fs.existsSync(trashDir('2026/11', trash.trashId))).toBe(true)
    fs.mkdirSync(app.file('.jot/trash/2026/12'), { recursive: true })
    fs.cpSync(trashDir('2026/11', trash.trashId), trashDir('2026/12', trash.trashId), { recursive: true })
    await expect(app.call('doc:restore', trash)).rejects.toThrow('回收编号重复')
    expect(fs.existsSync(trashDir('2026/11', trash.trashId))).toBe(true)
    expect(fs.existsSync(trashDir('2026/12', trash.trashId))).toBe(true)
  })

  it('旧平铺回收项明确提示先整理，不静默隐藏或删除', async () => {
    const note = await app.call('doc:create', { title: '旧回收格式' })
    const trash = await app.call('doc:delete', { ref: { path: note.path } })
    fs.renameSync(trashDir('2026/11', trash.trashId), app.file('.jot/trash/' + trash.trashId))
    await expect(app.call('trash:list', {})).rejects.toThrow('旧平铺回收项')
    expect(fs.existsSync(app.file('.jot/trash/' + trash.trashId + '/meta.json'))).toBe(true)
  })

  it('一次性分流演练仅移动明确旧记录，待归档资料保留并维护普通链接', async () => {
    app.write('inbox/2026/10/旧想法.md', '---\ntype: idea\ncreated: 2026-10-25T10:00:00+08:00\ntags: [保留]\n---\n旧记录')
    app.write('inbox/旧补记.md', '---\ntype: log\nstart: 2026-09-30\nend: 2026-09-30\n---\n旧补记')
    app.write('inbox/普通资料.md', '用途未确认的文档')
    app.write('inbox/导入资料.md', '原件内容')
    app.write('inbox/导入资料.md.meta.yaml', 'kind: attachment\ntags: [附件]\n')
    app.write('content/工作/入口.md', '[旧记录](../../inbox/2026/10/旧想法.md)')
    await app.core.syncIndex()
    await app.call('content:move', { path: 'inbox/2026/10/旧想法.md', targetPath: 'ideas/2026/10/旧想法.md' })
    await app.call('content:move', { path: 'inbox/旧补记.md', targetPath: 'ideas/2026/09/旧补记.md' })
    expect((await app.call('doc:resolveLink', { from: 'content/工作/入口.md', target: '../../ideas/2026/10/旧想法.md', kind: 'markdown' })).path).toBe('ideas/2026/10/旧想法.md')
    expect(decodeURI(raw('content/工作/入口.md'))).toContain('../../ideas/2026/10/旧想法.md')
    expect((await app.core.vault.read({ path: 'ideas/2026/10/旧想法.md' })).classification.tags).toEqual(['保留'])
    await app.reopen({ removeIndex: true })
    expect(app.core.classify.inbox({}).items.map(item => item.doc.path).sort()).toEqual(['inbox/导入资料.md', 'inbox/普通资料.md'].sort())
    expect(raw('inbox/导入资料.md.meta.yaml')).toContain('附件')
    expect((await app.call('library:query', { scope: { selection: { kind: 'collection', name: 'ideas' } } })).total).toBe(2)
  })

  it('助手拿到实际月份落点，显式写入 ideas 和 inbox 均可回读', async () => {
    const prompt = buildSystemPrompt([], new Date('2026-11-30T23:59:00+08:00'))
    expect(prompt).toContain('ideas/2026/11/')
    expect(prompt).toContain('inbox/2026/11/')
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'write_files', arguments: { files: [
        { path: 'ideas/2026/11/助手想法.md', body: '助手保存的想法' },
        { path: 'inbox/2026/11/助手文档.md', body: '助手保存的文档' },
      ] } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: 'ideas/2026/11/助手想法.md' } } }),
      () => '已保存两份内容。',
    ]))
    const conversation = app.core.agent.create()
    const run = await app.call('agent:send', { conversationId: conversation.conversationId, text: '保存我的想法和文档' })
    await app.core.agent.wait(run.runId)
    const answer = app.core.agent.get(conversation.conversationId).messages.at(-1)!
    expect(answer.error).toBeUndefined()
    expect(answer.toolCalls?.every(call => call.ok)).toBe(true)
    expect(answer.toolCalls?.[1]?.output).toContain('助手保存的想法')
    expect(app.core.classify.inbox({}).items.map(item => item.doc.path)).toEqual(['inbox/2026/11/助手文档.md'])
  })
})
