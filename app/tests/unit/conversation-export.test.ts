import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../shared/types'
import { conversationExportName, renderConversation } from '../../electron/agent/export'
import { createHandlers, type Platform } from '../../electron/ipc/handlers'
import { dispatch } from '../../electron/ipc/register'
import { argSchemas } from '../../electron/ipc/schemas'
import { deferred, testApp } from '../helpers/test-app'
import { agentScript, chunkIds } from '../helpers/fake-llm'

let app: Awaited<ReturnType<typeof testApp>>
const source = 'content/工作/材料 [定稿] #1%.md'
const makeHandlers = (saveFile: Platform['saveFile']) => createHandlers(app.core, {
  appInfo: () => ({ version: 'test', dev: true, platform: 'test' }), trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, pickDirectory: async () => null, saveFile,
  hideCapture: () => {}, resizeCapture: () => {}, openExternal: async () => {},
})
const records = (file: string) => fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
async function answer() {
  app.write(source, '实际材料：本周完成方案评审。')
  app.fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-review:weekly-report', path: 'references/outline.md' } } }),
    () => ({ toolCall: { name: 'read', arguments: { path: source } } }),
    results => '本周完成评审[^' + chunkIds(results[1]!)[0] + ']。\n未核实内容[^unknown]。',
  ]))
  const id = app.core.agent.create().conversationId
  const { runId } = app.core.agent.send(id, '$work-review:weekly-report 依据材料整理', {
    agentId: 'default', skillIds: ['work-review:weekly-report'], strict: true,
    references: [{ kind: 'file', value: source, title: '材料' }],
  })
  await app.core.agent.wait(runId)
  expect(app.core.agent.get(id).messages.at(-1)?.error).toBeUndefined()
  return id
}
function addStored(id: string, message: Partial<ChatMessage> & Pick<ChatMessage, 'messageId' | 'role' | 'text'>): void {
  app.core.state.raw.prepare('INSERT INTO messages(id,conversation_id,role,text,tool_calls,error,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(message.messageId, id, message.role, message.text, JSON.stringify(message), message.error ?? null, '2026-11-21T12:00:00+08:00')
}
beforeEach(async () => { app = await testApp() })
afterEach(async () => { vi.restoreAllMocks(); await app.close() })

describe('会话导出', () => {
  it('Markdown 导出完整问答、插件配置、真实工具及相对出处；取消不写，成功不改原对话', async () => {
    const id = await answer(), before = app.core.agent.get(id)
    const target = path.join(app.tmp.dir, 'exports', '讨论.md')
    const cancelled = makeHandlers(async () => null)
    expect(await dispatch(cancelled, 'agent:export', { conversationId: id, format: 'markdown' })).toEqual({ ok: true, data: null })
    expect(fs.existsSync(target)).toBe(false)
    const handlers = makeHandlers(async options => {
      expect(options).toMatchObject({ format: 'markdown' })
      expect(options.defaultPath).toMatch(/\.md$/)
      return target
    })
    const count = app.fake.requests.length
    expect(await dispatch(handlers, 'agent:export', { conversationId: id, format: 'markdown' })).toEqual({ ok: true, data: { path: target } })
    const text = fs.readFileSync(target, 'utf8')
    expect(text).toContain('## 1. 用户')
    expect(text).toContain('## 2. 助手')
    expect(text).toContain('智能体：通用助手')
    expect(text).toContain('显式技能：work-review:weekly-report')
    expect(text).toContain('use_skill · 成功')
    expect(text).toContain('read · 成功')
    expect(text).toContain('references/outline.md')
    expect(text).toContain('材料 \\[定稿\\] #1%')
    expect(text).toContain(encodeURI('../vault/content/工作/材料 [定稿] #1%.md').replace(/[?#()[\]]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()))
    expect(text).toContain('（来源未核实）')
    expect(text).not.toContain('[^unknown]')
    expect(app.core.agent.get(id)).toEqual(before)
    expect(app.fake.requests).toHaveLength(count)
  })

  it('JSONL 保留原消息、工具交错、隐藏／中断／失败状态、两种摘要；重启与索引丢失后仍一致', async () => {
    const id = await answer(), original = app.core.agent.get(id).messages.at(-1)!
    app.core.agent.removeRecord(original.runId!)
    addStored(id, { messageId: 'stopped-user', role: 'user', text: '追加问题\n保留换行' })
    addStored(id, { messageId: 'stopped-answer', role: 'assistant', text: '中断前正文', runState: 'interrupted', error: '应用意外退出', parts: [
      { type: 'text', text: '先核对' }, { type: 'tool', call: { name: 'write_files', summary: '覆盖', ok: false,
        input: { path: 'content/工作/目标.md' }, output: '未执行',
        confirmation: { id: 'confirm', title: '覆盖', targets: [{ path: 'content/工作/目标.md', action: 'overwrite' }], state: 'rejected' } } },
    ] })
    for (const mode of ['normal', 'strict']) app.core.state.raw.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?)')
      .run(id, mode, original.messageId, '用户希望按材料继续核对方案与约束，不把建议当作已完成事项。', original.createdAt)
    const before = app.core.agent.exportSnapshot(id)
    await app.reopen({ removeIndex: true })
    const target = path.join(app.tmp.dir, '完整问答.jsonl')
    expect((await dispatch(makeHandlers(async () => target), 'agent:export', { conversationId: id, format: 'jsonl' })).ok).toBe(true)
    const lines = records(target)
    expect(lines[0]).toMatchObject({ type: 'conversation', format: 'jot-conversation', version: 1, conversation: before.info, context: before.context })
    expect(lines.filter(row => row.type === 'message').map(row => row.message)).toEqual(JSON.parse(JSON.stringify(before.messages)))
    expect(lines.filter(row => row.type === 'summary').map(({ type: _type, ...summary }) => summary)).toEqual(before.summaries)
    expect(lines.find(row => row.message?.messageId === original.messageId).message.runHidden).toBe(true)
    expect(lines.at(-1).mode).toBe('strict')
    expect(fs.readFileSync(target, 'utf8')).not.toContain(app.fake.baseUrl)
    await app.core.agent.delete(id)
    expect(records(target)).toEqual(lines)
  })

  it('Markdown 附接续摘要但不替换原文，代码里的出处与工具结果围栏保持原样', () => {
    const id = app.core.agent.create().conversationId, tick = String.fromCharCode(96)
    addStored(id, { messageId: 'user', role: 'user', text: '原问题不能被摘要替换' })
    addStored(id, { messageId: 'assistant', role: 'assistant', text: tick.repeat(3) + '\n示例[^unknown]\n' + tick.repeat(3), toolCalls: [
      { name: '<read>', summary: '保留内容', output: tick.repeat(4) + '\n</details>\n原样数据', ok: false },
    ] })
    app.core.state.raw.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?)').run(id, 'normal', 'assistant', '只作为较早对话接续，不替代完整问答。', '2026-11-21')
    const rendered = renderConversation(app.core.agent.exportSnapshot(id), 'markdown', app.root, path.join(app.tmp.dir, '导出.md'))
    expect(rendered).toContain('原问题不能被摘要替换')
    expect(rendered).toContain('示例[^unknown]')
    expect(rendered).toContain('对话接续摘要')
    expect(rendered).toContain('&lt;read&gt; · 失败')
    expect(rendered).toContain(tick.repeat(5) + 'text\n' + tick.repeat(4))
  })

  it('在途回答拒绝导出；停止后可导出已保存问题与步骤，写入失败保留原文件可重试', async () => {
    const release = deferred(), arrived = deferred()
    app.fake.setResponder(agentScript([async () => { arrived.release(); await release.promise; return '迟到回答' }]))
    const id = app.core.agent.create().conversationId
    const { runId } = app.core.agent.send(id, '等待中的问题')
    await arrived.promise
    const target = path.join(app.tmp.dir, '可重试.jsonl'), picker = vi.fn(async () => target)
    const handlers = makeHandlers(picker)
    try {
      expect(await dispatch(handlers, 'agent:export', { conversationId: id, format: 'jsonl' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect(picker).not.toHaveBeenCalled()
      await app.core.agent.abort(runId)
      fs.writeFileSync(target, '原文件')
      vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('虚构保存失败'))
      expect(await dispatch(handlers, 'agent:export', { conversationId: id, format: 'jsonl' })).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } })
      expect(fs.readFileSync(target, 'utf8')).toBe('原文件')
      expect((await dispatch(handlers, 'agent:export', { conversationId: id, format: 'jsonl' })).ok).toBe(true)
      expect(records(target).find(row => row.message?.role === 'assistant').message.error).toBe('已停止')
      expect(fs.readdirSync(app.tmp.dir).some(name => name.startsWith('.jot-write.'))).toBe(false)
    } finally { release.release() }
  })

  it.each(['delete', 'vault'] as const)('保存窗口期间 %s 后拒绝写出旧快照；同时导出不重复打开窗口', async action => {
    const id = app.core.agent.create().conversationId, pending = deferred(), entered = deferred()
    const target = path.join(app.tmp.dir, '旧快照.md')
    const handlers = makeHandlers(async () => { entered.release(); await pending.promise; return target })
    const result = dispatch(handlers, 'agent:export', { conversationId: id, format: 'markdown' })
    await entered.promise
    expect(await dispatch(handlers, 'agent:export', { conversationId: id, format: 'markdown' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    if (action === 'delete') await app.core.agent.delete(id)
    else await app.core.openVault(path.join(app.tmp.dir, 'second'), true)
    pending.release()
    expect(await result).toMatchObject({ ok: false, error: { code: action === 'delete' ? 'NOT_FOUND' : 'CONFLICT' } })
    expect(fs.existsSync(target)).toBe(false)
  })

  it('库内导出经过写入权限，保护 .jot；离线导出空会话且不新增状态结构', async () => {
    const id = app.core.agent.create().conversationId
    const tables = app.core.state.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    const blocked = path.join(app.root, '.jot/skills/覆盖.md')
    expect(await dispatch(makeHandlers(async () => blocked), 'agent:export', { conversationId: id, format: 'markdown' })).toMatchObject({ ok: false, error: { code: 'WRITE_DENIED' } })
    const relative = path.join(app.root, 'content/工作/空会话.md')
    expect((await dispatch(makeHandlers(async () => relative), 'agent:export', { conversationId: id, format: 'markdown' })).ok).toBe(true)
    expect(fs.readFileSync(relative, 'utf8')).toContain('尚无消息。')
    expect(app.core.state.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(tables)
    expect(app.fake.requests).toHaveLength(0)
  })

  it('格式参数严格校验，保存路径扩展名匹配，Windows 标题可作为文件名', async () => {
    for (const input of [{ conversationId: 'x', format: 'pdf' }, { conversationId: '', format: 'jsonl' }, { conversationId: 'x', format: 'markdown', path: 'D:/任意路径.md' }]) {
      expect(argSchemas['agent:export'].safeParse(input).success).toBe(false)
    }
    const id = app.core.agent.create().conversationId
    for (const target of ['relative.md', path.join(app.tmp.dir, '错误.txt')]) {
      expect(await dispatch(makeHandlers(async () => target), 'agent:export', { conversationId: id, format: 'markdown' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(conversationExportName('CON', 'markdown')).toBe('对话-CON.md')
    expect(conversationExportName('a/b:c?d.\n', 'jsonl')).toBe('a-b-c-d.jsonl')
    expect(conversationExportName('..', 'markdown')).toBe('对话.md')
  })
})
