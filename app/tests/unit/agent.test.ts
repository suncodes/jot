import { absoluteFileHref } from '../../shared/file-links'
import { answerNoteBody } from '../../shared/answer-note'
import { renderConversation } from '../../electron/agent/export'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantContext } from '@shared/assistant'
import type { AgentEvent } from '@shared/types'
import { loadPi } from '../../electron/agent/pi'
import { AgentFiles } from '../../electron/agent/files'
import { createTools } from '../../electron/agent/tools'
import { agentScript, chunkIds, isAgentRequest } from '../helpers/fake-llm'
import { deferred, testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
let events: AgentEvent[]
const file = 'content/工作/计划/采购.md'
const other = 'content/生活/日常.md'
const context = (strict = false): AssistantContext => ({ agentId: 'default', strict, skillIds: [], references: [{ kind: 'file', value: file, title: '采购' }] })
const readScript = () => agentScript([
  () => ({ toolCall: { name: 'read', arguments: { path: file } } }),
  results => '当前材料[^' + chunkIds(results[0]!)[0] + ']。',
])
const agentRequests = () => app.fake.requests.filter(isAgentRequest)
async function ask(id: string, text = '核对采购', request?: AssistantContext, retryMessageId?: string) {
  const { runId } = await app.call('agent:send', { conversationId: id, text, ...(request ? { context: request } : {}), ...(retryMessageId ? { retryMessageId } : {}) })
  await app.core.agent.wait(runId)
  return app.core.agent.get(id).messages.at(-1)!
}
async function pending(id: string, tool: string, args: Record<string, unknown>) {
  app.fake.setResponder(agentScript([() => ({ toolCall: { name: tool, arguments: args } }), () => '操作过程已结束。']))
  const { runId } = await app.call('agent:send', { conversationId: id, text: '执行我列出的操作' })
  await expect.poll(() => events.find(e => e.type === 'tool-update' && e.runId === runId)?.type).toBe('tool-update')
  const event = events.find(e => e.type === 'tool-update' && e.runId === runId) as Extract<AgentEvent, { type: 'tool-update' }>
  return { runId, call: event.call, confirmation: event.call.confirmation! }
}

beforeEach(async () => {
  events = []
  app = await testApp((name, data) => { if (name === 'agent:event') events.push(structuredClone(data as AgentEvent)) })
  app.write(file, '---\ntags: [采购]\ncustom: 保留\n---\n原始清单：茶叶和水果。\n')
  app.write(other, '---\ntags: [生活]\n---\n周末散步。\n')
  await app.core.syncIndex()
  app.fake.setResponder(agentScript([() => '好的。']))
})
afterEach(async () => { await app.close() })

describe('当前文件与路径引用', () => {

  it('AI 摘要的来源说明取当前属性；未索引或索引过期都不伪造旧来源', async () => {
    const summary = 'wiki/sources/摘要.md'
    app.write(summary, '---\ntype: source-summary\ngenerated_by: ai\nsource: content/工作/旧原件.txt\n---\n当前摘要正文')
    await app.core.syncIndex()
    app.write(summary, '---\ntype: source-summary\ngenerated_by: ai\nsource: content/工作/新原件.txt\n---\n当前摘要正文')
    vi.spyOn(app.core.index, 'upsert').mockReturnValue(app.core.index.getDoc(summary)!)
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: summary } } }),
      results => '摘要内容[^' + chunkIds(results[0]!)[0] + ']。',
    ]))
    const result = await ask(app.core.agent.create().conversationId)
    expect(result.citations![0]).toMatchObject({ valid: true, basedOn: ['content/工作/新原件.txt'] })
    app.core.index.remove(summary)
    const unindexed = await ask(app.core.agent.create().conversationId)
    expect(unindexed.citations![0]).toMatchObject({ valid: true, basedOn: ['content/工作/新原件.txt'] })
  })

  it('真实工具过程、流式文本和短出处落入消息；普通问答不写内容文件', async () => {
    app.fake.setResponder(readScript())
    const before = await app.core.vault.listFiles()
    const id = app.core.agent.create().conversationId
    const result = await ask(id, '采购什么', context())
    expect(result.error).toBeUndefined()
    expect(events.filter(e => e.type !== 'text').map(e => e.type)).toEqual(['budget', 'tool-start', 'tool-end', 'budget', 'done'])
    expect(result.budget).toMatchObject({ contextWindow: 32768, source: 'default', blocked: false })
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('').trim()).toBe(result.text)
    expect(result.toolCalls).toEqual([expect.objectContaining({ name: 'read', input: { path: file }, ok: true, output: expect.stringContaining('原始清单'), durationMs: expect.any(Number) })])
    expect(result.citations).toMatchObject([{ valid: true, chunk: { path: file, lineStart: 1, text: '---\ntags: [采购]\ncustom: 保留\n---\n原始清单：茶叶和水果。\n' } }])
    const data = await app.call('agent:get', { conversationId: id })
    expect(data.context).toMatchObject(context())
    expect(data.messages[0]!.context!.references).toEqual(context().references)
    expect(data.messages[0]!.context!.references[0]).not.toHaveProperty('body')
    expect(data.messages[0]!.context!.references[0]).not.toHaveProperty('draft')
    expect(await app.core.vault.listFiles()).toEqual(before)
    expect(JSON.stringify(agentRequests()[0]!.messages)).not.toContain('原始清单')
    expect(fs.existsSync(app.file('.jot/sessions'))).toBe(false)
    expect(app.core.state.raw.prepare("SELECT name FROM sqlite_master WHERE name='conv_chunks'").get()).toBeUndefined()
  })

  it('索引尚旧时 read、search 都返回磁盘当前正文；无索引文件也可读取', async () => {
    vi.spyOn(app.core.index, 'upsert').mockReturnValue(app.core.index.getDoc(file)!)
    app.write(file, '外部刚改：采购咖啡。')
    app.write('content/工作/未索引.md', '刚创建的材料')
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'search', arguments: { query: '原始清单' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: 'content/工作/未索引.md' } } }),
      results => '读到了[^' + chunkIds(results[1]!)[0] + ']。',
    ]))
    const result = await ask(app.core.agent.create().conversationId)
    expect(result.toolCalls![0]!.output).toContain('采购咖啡')
    expect(result.toolCalls![0]!.output).not.toContain('原始清单')
    expect(result.toolCalls![1]!.output).toContain('刚创建的材料')
  })

  it('多轮继承路径，重读外部更新；重启后仍继承选择，旧工具正文不进入新轮', async () => {
    const id = app.core.agent.create().conversationId
    app.fake.setResponder(readScript())
    await ask(id, '第一问', context())
    app.write(file, '第二轮的新采购：咖啡')
    await ask(id, '接着说')
    expect(app.core.agent.get(id).messages.at(-1)!.toolCalls![0]!.output).toContain('咖啡')
    const request = agentRequests().at(-2)!
    expect(JSON.stringify(request.messages)).toContain('第一问')
    expect(JSON.stringify(request.messages)).not.toContain('原始清单')
    expect(app.core.agent.get(id).messages.at(-2)!.context!.references).toEqual(context().references)
    await app.reopen()
    app.fake.setResponder(readScript())
    const result = await ask(id, '重启后继续')
    expect(result.toolCalls![0]!.output).toContain('咖啡')
    expect(result.context!.references).toEqual(context().references)
    expect(app.core.agent.get(id).messages).toHaveLength(6)
  })

  it('只在本轮读取过的编号有效；不把旧轮片段重新授予引用资格', async () => {
    const id = app.core.agent.create().conversationId
    app.fake.setResponder(readScript())
    const first = await ask(id)
    const marker = first.citations![0]!.marker
    app.fake.setResponder(agentScript([() => '引用旧轮[^' + marker + ']，另一个编造[^unknown]。']))
    const second = await ask(id, '再说')
    expect(second.citations).toEqual([{ marker, valid: false }, { marker: 'unknown', valid: false }])
    expect(app.core.agent.get(id).messages[1]!.citations![0]!.valid).toBe(true)
  })

  it('应用内移动更新后续选择和重启状态，历史路径不改写；外部移动缺失不猜身份', async () => {
    const id = app.core.agent.create().conversationId
    await ask(id, '先引用', context())
    const to = 'content/工作/计划/新采购.md'
    await app.call('content:move', { path: file, targetPath: to })
    expect(app.core.agent.get(id).context!.references[0]!.value).toBe(to)
    expect(app.core.agent.get(id).messages[0]!.context!.references[0]!.value).toBe(file)
    await app.reopen()
    const result = await ask(id, '接着问')
    expect(result.context!.references[0]!.value).toBe(to)
    fs.renameSync(app.file(to), app.file(file))
    const missing = await ask(id, '再继续')
    expect(missing.error).toContain('引用路径不存在')
    expect(missing.error).not.toContain('指纹')
  })

  it('重新回答沿用原问题和路径，使用当前正文、模型和智能体配置，保留旧消息', async () => {
    const agent = { id: 'custom-read', name: '阅读', description: '阅读资料', instructions: '第一版说明', skillIds: [], toolIds: ['read'], enabled: true }
    await app.call('capabilities:changeAgent', { action: 'save', agent })
    const id = app.core.agent.create().conversationId
    app.fake.setResponder(readScript())
    const first = await ask(id, '原问题', { ...context(), agentId: agent.id })
    const question = app.core.agent.get(id).messages[0]!
    app.write(file, '已更新：新预算')
    await app.call('capabilities:changeAgent', { action: 'save', agent: { ...agent, instructions: '第二版说明' } })
    await app.call('settings:set', { model: { model: 'next-model', baseUrl: app.fake.baseUrl, apiKey: 'fake' } })
    const retried = await ask(id, '忽略这个参数', undefined, question.messageId)
    expect(retried.toolCalls![0]!.output).toContain('新预算')
    expect(retried.context!.agent.instructions).toBe('第二版说明')
    expect(agentRequests().at(-1)!.model).toBe('next-model')
    const messages = app.core.agent.get(id).messages
    expect(messages).toHaveLength(4)
    expect(messages[1]).toEqual(first)
    expect(messages[2]!.text).toBe('原问题')
  })

  it('拒绝旧草稿正文及项目引用契约；空严格范围保留失败原因', async () => {
    const id = app.core.agent.create().conversationId
    await expect(app.call('agent:send', { conversationId: id, text: '旧草稿', context: { ...context(), references: [{ ...context().references[0]!, draft: '不能夹带正文' }] } } as never)).rejects.toThrow('INVALID_INPUT')
    await expect(app.call('agent:send', { conversationId: id, text: '旧项目', context: { ...context(), references: [{ kind: 'project', value: '采购', title: '采购' }] } } as never)).rejects.toThrow('INVALID_INPUT')
    const result = await ask(id, '空范围', { ...context(true), references: [] })
    expect(result.error).toContain('限定材料为空')
  })
})

describe('材料范围与真实工具', () => {
  it('严格目录默认物理子树；显式相关只扩一跳，查询参数不能扩大读取范围', async () => {
    const related = 'inbox/关联.md'
    app.write(related, '---\nrelated: [content/工作/计划]\ntags: [相关]\n---\n相关材料')
    app.write('inbox/二跳.md', '---\nrelated: [inbox/关联.md]\n---\n二跳材料')
    await app.core.syncIndex()
    const selected: AssistantContext = { ...context(true), references: [{ kind: 'folder', value: 'content/工作/计划', title: '计划' }] }
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'search', arguments: { directory: 'content/生活' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: other } } }),
      () => ({ toolCall: { name: 'list_directory', arguments: { path: 'content' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: related } } }),
      () => '结束',
    ]))
    let result = await ask(app.core.agent.create().conversationId, '限定目录', selected)
    expect(result.toolCalls![0]!.output).not.toContain('周末散步')
    expect(result.toolCalls![1]!).toMatchObject({ ok: false, output: expect.stringContaining('超出本轮限定材料') })
    expect(result.toolCalls![2]!.output).not.toContain('content/生活')
    expect(result.toolCalls![3]!.ok).toBe(false)
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: related } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: 'inbox/二跳.md' } } }),
      () => ({ toolCall: { name: 'stats', arguments: { groupBy: 'type' } } }),
      () => ({ toolCall: { name: 'list_tags', arguments: {} } }),
      () => '结束',
    ]))
    result = await ask(app.core.agent.create().conversationId, '包含相关', selected)
    expect(result.toolCalls![0]!.ok).toBe(false)
    expect(result.toolCalls![1]!.ok).toBe(false)
    expect(result.toolCalls![2]!.output).toContain('合计：1')
    expect(result.toolCalls![3]!.output).not.toContain('相关')
    expect(result.toolCalls![3]!.output).not.toContain('生活')
  })

  it('严格读取约定不阻止明确输出到另一个目录', async () => {
    const output = 'content/工作/整理结果.md'
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: file } } }),
      () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: output, body: '根据材料整理的结果' }] } } }),
      () => '已保存',
    ]))
    const result = await ask(app.core.agent.create().conversationId, '只根据引用整理，保存到工作/整理结果', context(true))
    expect(result.toolCalls!.every(c => c.ok)).toBe(true)
    expect(fs.readFileSync(app.file(output), 'utf8')).toContain('整理的结果')
  })

  it('timeline 对普通文件只报告有更新，明确随手记才附正文；无效日期返回工具错误', async () => {
    app.write('content/当天资料.md', '---\ncreated: 2026-11-19\n---\n原始清单')
    app.write('inbox/记录.md', '---\ntype: idea\ncreated: 2026-11-19T10:00:00+08:00\n---\n今天明确完成一件事')
    await app.core.syncIndex()
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'timeline', arguments: { from: '2026-11-19' } } }),
      () => ({ toolCall: { name: 'timeline', arguments: { from: '2026-02-30' } } }),
      () => '已核对',
    ]))
    const result = await ask(app.core.agent.create().conversationId)
    expect(result.toolCalls![0]!.output).toContain('具体变化未确认')
    expect(result.toolCalls![0]!.output).toContain('今天明确完成一件事')
    expect(result.toolCalls![0]!.output).not.toContain('原始清单')
    expect(result.toolCalls![1]!.ok).toBe(false)
  })

  it('目录直接发现空目录；read 分页；枚举清理不改变拟编辑文本', async () => {
    fs.mkdirSync(app.file('content/工作/空目录'))
    app.write('content/工作/长文.md', Array.from({ length: 70 }, (_, i) => '## 第' + (i + 1) + '节\n' + '当前内容。'.repeat(45)).join('\n\n'))
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'list_directory', arguments: { path: 'content/工作' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: 'content/工作/长文.md' } } }),
      () => '已读取',
    ]))
    const result = await ask(app.core.agent.create().conversationId)
    expect(result.toolCalls![0]!.output).toContain('folder content/工作/空目录')
    expect(result.toolCalls![1]!.output).toContain('nextRead: {')
    expect(result.toolCalls![1]!.output!.length).toBeLessThan(8000)
    const files = new AgentFiles({ operations: () => app.core.operations, vault: app.core.vault, index: app.core.index, mutate: op => app.core.mutate(op), changed: () => app.core.idle(), moved: paths => app.core.agent.moveReferences(paths), trashed: () => {} })
    const tools = createTools(await loadPi(), app.core.index, { scope: () => ({}), cite: () => {}, confirm: async () => false, onStart: () => {}, onEnd: () => {} }, files)
    expect(tools.find(t => t.name === 'edit_file')!.prepareArguments!({ path: file, before: '  原文\n', after: '\n替换  ' })).toEqual({ path: file, before: '  原文\n', after: '\n替换  ' })
    expect(tools.find(t => t.name === 'stats')!.prepareArguments!({ groupBy: '\n"folder"\n' })).toEqual({ groupBy: 'folder' })
  })

  it('智能体真实工具白名单与显式技能生效，未允许写工具不传给模型', async () => {
    const skill = { name: 'reading', title: '阅读方法', description: '核对文档', body: '仅提炼明确结论', requiredTools: ['read'] }
    const agent = { id: 'readonly', name: '只读助手', description: '只读', instructions: '按阅读技能核对', skillIds: ['reading'], toolIds: ['read'], enabled: true }
    await app.call('capabilities:changeSkill', { action: 'save', content: skill, enabled: true })
    await app.call('capabilities:changeAgent', { action: 'save', agent })
    await ask(app.core.agent.create().conversationId, '/reading 核对', { ...context(), agentId: 'readonly', skillIds: ['reading'] })
    const request = agentRequests().at(-1)!
    expect((request.tools as { function: { name: string } }[]).map(t => t.function.name)).toEqual(['read', 'use_skill'])
    expect(JSON.stringify(request.messages)).toContain('仅提炼明确结论')
    const invalid = await ask(app.core.agent.create().conversationId, '错误技能', { ...context(), agentId: 'readonly', skillIds: ['weekly-report'] })
    expect(invalid.error).toContain('不属于当前智能体')
  })

  it('显式技能按需读取包内文本，严格材料、手动触发和包边界同时生效', async () => {
    const name = 'reading-template'
    const folder = '.jot/skills/' + name
    const skillBody = '仅阅读模板；用 use_skill 读取 references/format.md。'
    app.write(folder + '/SKILL.md', '---\nname: ' + name + '\ndescription: 阅读模板\ndisable-model-invocation: true\nrequired_tools: [read]\n---\n' + skillBody)
    app.write(folder + '/references/format.md', '模板列：出处、观察和行动')
    app.write(folder + '/assets/image.bin', Buffer.from([0, 200, 48]))
    app.write('.jot/skills/needs-tool/SKILL.md', '---\nname: needs-tool\ndescription: 缺少工具\nrequired_tools: [remote_tool]\n---\n正文')
    const shared = path.join(app.root, 'content', '生活')
    fs.symlinkSync(shared, app.file(folder + '/linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const id = app.core.agent.create().conversationId
    const steps = [
      { name: 'use_skill', arguments: { name } },
      { name: 'use_skill', arguments: { name, path: 'references/format.md' } },
      { name: 'use_skill', arguments: { name, path: '../needs-tool/SKILL.md' } },
      { name: 'use_skill', arguments: { name, path: 'linked/日常.md' } },
      { name: 'use_skill', arguments: { name, path: 'assets/image.bin' } },
      { name: 'read', arguments: { path: folder + '/references/format.md' } },
      { name: 'read', arguments: { path: other } },
      { name: 'use_skill', arguments: { name: 'needs-tool' } },
    ]
    app.fake.setResponder(agentScript([() => ({ toolCall: steps[0]! }), () => '普通问答可继续。']))
    const automatic = await ask(id, '普通问答', context(true))
    expect(automatic.error).toBeUndefined()
    expect(automatic.toolCalls?.[0]).toMatchObject({ ok: false, output: expect.stringContaining('没有这个可用技能') })
    expect(automatic.context!.skills.some(s => s.name === name || s.name === 'needs-tool')).toBe(false)

    app.fake.setResponder(agentScript([...steps.map(toolCall => () => ({ toolCall })), results => String(results[1])]))
    const manual = await ask(id, '$' + name + ' 核对', { ...context(true), skillIds: [name] })
    expect(manual.text).toContain('出处、观察和行动')
    const calls = manual.toolCalls!
    expect(calls).toHaveLength(steps.length)
    expect(calls[0]).toMatchObject({ ok: true, output: expect.stringContaining(skillBody) })
    expect(calls[1]).toMatchObject({ ok: true, output: '模板列：出处、观察和行动' })
    expect(calls.slice(2).map(call => call.ok)).toEqual([false, false, false, false, false, false])
    expect(calls[2]!.output).toContain('包内相对路径')
    expect(calls[3]!.output).toContain('不能使用链接')
    expect(calls[4]!.output).toContain('UTF-8')
    expect(calls[5]!.output).toContain('专用管理操作')
    expect(calls[6]!.output).toContain('超出本轮限定材料')
    expect(calls[7]!.output).toContain('没有这个可用技能')
    expect(manual.context?.skills.find(s => s.name === name)).toEqual({ id: name, name, title: name })
  })
})

describe('写入确认与停止', () => {

  it('同轮已确认目标不重复确认，新增覆盖目标需要再次列出确认', async () => {
    const id = app.core.agent.create().conversationId
    const first = await pending(id, 'write_files', { files: [{ path: file, body: '第一次' }] })
    app.fake.setResponder(agentScript([
      () => '不应到这里',
      () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: file, body: '第二次' }] } } }),
      () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: file, body: '第三次' }, { path: other, body: '新增目标' }] } } }),
      () => '结束',
    ]))
    await app.call('agent:confirm', { runId: first.runId, requestId: first.confirmation.id, approved: true })
    await expect.poll(() => events.filter(e => e.type === 'tool-update' && e.call.confirmation?.state === 'pending').length).toBe(2)
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('第二次')
    expect(fs.readFileSync(app.file(other), 'utf8')).toContain('周末散步')
    const next = events.filter(e => e.type === 'tool-update' && e.call.confirmation?.state === 'pending').at(-1) as Extract<AgentEvent, { type: 'tool-update' }>
    expect(next.call.confirmation!.targets.map(t => t.path)).toEqual([file, other])
    await app.call('agent:confirm', { runId: first.runId, requestId: next.call.confirmation!.id, approved: false })
    await app.core.agent.wait(first.runId)
    expect(app.core.agent.get(id).messages.at(-1)!.toolCalls!.map(t => t.ok)).toEqual([true, true, false])
  })

  it('覆盖多个文件集中确认一次，等待期间不写盘，伪造和过期确认无效', async () => {
    const id = app.core.agent.create().conversationId
    const item = await pending(id, 'write_files', { files: [{ path: file, body: '---\ncustom: 保留\n---\n新采购清单' }, { path: other, body: '新日常' }] })
    expect(item.confirmation.targets.map(t => t.path)).toEqual([file, other])
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('原始清单')
    await expect(app.call('agent:confirm', { runId: item.runId, requestId: 'fake', approved: true })).rejects.toThrow('已结束')
    await app.call('agent:confirm', { runId: item.runId, requestId: item.confirmation.id, approved: true })
    await app.core.agent.wait(item.runId)
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('新采购清单')
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('custom: 保留')
    expect(fs.readFileSync(app.file(other), 'utf8')).toContain('新日常')
    expect(events.filter(e => e.type === 'tool-update' && e.call.confirmation?.state === 'pending')).toHaveLength(1)
    const result = app.core.agent.get(id).messages.at(-1)!
    expect(result.toolCalls![0]!.confirmation!.state).toBe('approved')
    await expect(app.call('agent:confirm', { runId: item.runId, requestId: item.confirmation.id, approved: true })).rejects.toThrow('已结束')
  })

  it.each(['reject', 'abort'] as const)('等待覆盖时 %s，草稿目标不变且等待不挂起', async action => {
    const id = app.core.agent.create().conversationId
    const item = await pending(id, 'write_files', { files: [{ path: file, body: '不应写入' }] })
    if (action === 'abort') await app.call('agent:abort', { runId: item.runId })
    else await app.call('agent:confirm', { runId: item.runId, requestId: item.confirmation.id, approved: false })
    await app.core.agent.wait(item.runId)
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('原始清单')
    const result = app.core.agent.get(id).messages.at(-1)!
    expect(result.toolCalls![0]!.confirmation!.state).toBe('rejected')
    expect(result.toolCalls![0]!.ok).toBe(false)
    if (action === 'abort') expect(result.error).toBe('已停止')
  })

  it('拒绝过的目标在同一轮不重复弹窗，也不执行第二次覆盖', async () => {
    const id = app.core.agent.create().conversationId
    const item = await pending(id, 'write_files', { files: [{ path: file, body: '第一次' }] })
    app.fake.setResponder(agentScript([
      () => '不应到这里',
      () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: file, body: '第二次' }] } } }),
      () => '停止此操作',
    ]))
    await app.call('agent:confirm', { runId: item.runId, requestId: item.confirmation.id, approved: false })
    await app.core.agent.wait(item.runId)
    expect(events.filter(e => e.type === 'tool-update' && e.call.confirmation?.state === 'pending')).toHaveLength(1)
    expect(app.core.agent.get(id).messages.at(-1)!.toolCalls).toHaveLength(2)
    expect(fs.readFileSync(app.file(file), 'utf8')).toContain('原始清单')
  })

  it('回收确认列真实文件和附件属性，确认前不回收，批准后可恢复', async () => {
    app.write('content/工作/资料.txt', '附件原件')
    await app.core.vault.patchFrontmatter({ path: 'content/工作/资料.txt' }, { tags: ['资料'] }, 'user')
    const id = app.core.agent.create().conversationId
    const item = await pending(id, 'trash', { paths: ['content/工作/资料.txt', file] })
    expect(item.confirmation.targets.map(t => t.path)).toEqual(expect.arrayContaining([file, 'content/工作/资料.txt', 'content/工作/资料.txt.meta.yaml']))
    await app.call('agent:confirm', { runId: item.runId, requestId: item.confirmation.id, approved: true })
    await app.core.agent.wait(item.runId)
    expect(fs.existsSync(app.file(file))).toBe(false)
    const trash = await app.call('trash:list', {})
    expect(trash.total).toBe(2)
    const source = trash.items.find(t => t.originalPath.endsWith('资料.txt'))!
    await app.call('doc:restore', { trashId: source.trashId })
    expect(fs.readFileSync(app.file('content/工作/资料.txt'), 'utf8')).toBe('附件原件')
  })
})

describe('历史、失败与恢复', () => {

  it('模型失败保留错误和问题，手动重问重新请求模型而不回放旧结果', async () => {
    const id = app.core.agent.create().conversationId
    app.fake.setResponder(agentScript([() => ({ status: 500, body: '{"error":{"message":"虚构模型失败"}}' })]))
    const failed = await ask(id, '失败的问题', context())
    expect(failed.error).toBeTruthy()
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'LLM_UNAVAILABLE' } })
    const first = app.core.agent.get(id).messages[0]!
    app.fake.setResponder(readScript())
    const retry = await ask(id, '忽略这个问题', undefined, first.messageId)
    expect(retry.error).toBeUndefined()
    expect(retry.toolCalls![0]!.ok).toBe(true)
    expect(app.core.agent.get(id).messages).toHaveLength(4)
  })

  it('工具路径及参数错误记录真实失败，回答继续；不读取库外或内部文件', async () => {
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: '../outside' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: '.jot/state.db' } } }),
      () => ({ toolCall: { name: 'read', arguments: { lineStart: 1 } } }),
      () => '未读取',
    ]))
    const result = await ask(app.core.agent.create().conversationId)
    expect(result.toolCalls!.map(c => c.ok)).toEqual([false, false, false])
    expect(result.toolCalls![2]!.summary).toContain('参数校验失败')
    expect(result.toolCalls![2]!.errorKind).toBe('validation')
    expect(result.toolCalls![2]!.input).toEqual({ lineStart: 1 })
    expect(result.text).toBe('未读取')
  })

  it('运行记录包含结果、配置和耗时；隐藏记录不删除对话，历史可搜索、分页、改名和删除', async () => {
    const id = app.core.agent.create().conversationId
    const result = await ask(id, '采购线索', context())
    expect(result.durationMs).toEqual(expect.any(Number))
    expect(app.core.agent.records({ text: '采购' }).total).toBe(1)
    app.core.agent.removeRecord(result.runId!)
    expect(app.core.agent.records({}).total).toBe(0)
    expect(app.core.agent.get(id).messages).toHaveLength(2)
    await app.call('agent:rename', { conversationId: id, title: '阅读采购' })
    expect(app.core.agent.conversations({ text: '阅读', limit: 1 }).total).toBe(1)
    await app.call('agent:delete', { conversationId: id })
    expect(app.core.agent.conversations({}).total).toBe(0)
  })

  it('真实模型配置变化停止在途回答，普通布局和主题变化继续', async () => {
    const waiting = deferred(), arrived = deferred()
    app.fake.setResponder(agentScript([async () => { arrived.release(); await waiting.promise; return '迟到回答' }]))
    const id = app.core.agent.create().conversationId
    const { runId } = await app.call('agent:send', { conversationId: id, text: '等待' })
    try {
      await arrived.promise
      await app.call('settings:set', { appearance: { theme: 'dark' }, layout: { agentCollapsed: true } })
      expect(app.core.agent.get(id).running).toBe(runId)
      await expect(app.call('agent:send', { conversationId: id, text: '插队' })).rejects.toThrow('先停止')
      await app.call('settings:set', { model: { model: 'another', baseUrl: app.fake.baseUrl, apiKey: 'fake' } })
      await app.core.agent.wait(runId)
      expect(app.core.agent.get(id).messages.at(-1)!.error).toBe('已停止')
    } finally { waiting.release() }
  })

  it('恢复真实运行检查点，待确认动作取消且不自动重放；仍可主动重问', async () => {
    const id = app.core.agent.create().conversationId
    const item = await pending(id, 'trash', { paths: [file] })
    const row = app.core.state.raw.prepare("SELECT id,tool_calls FROM messages WHERE conversation_id=? AND role='assistant'").get(id) as { id: string; tool_calls: string }
    const checkpoint = JSON.parse(row.tool_calls)
    expect(checkpoint.runState).toBe('running')
    await app.core.agent.abort(item.runId)
    app.core.state.raw.prepare('UPDATE messages SET tool_calls=?,error=NULL WHERE id=?').run(row.tool_calls, row.id)
    await app.reopen()
    const count = app.fake.requests.length
    app.core.agent.recoverInterrupted()
    const recovered = app.core.agent.get(id)
    expect(recovered.messages.at(-1)).toMatchObject({ runState: 'interrupted', runId: item.runId, durationMs: checkpoint.durationMs })
    const step = recovered.messages.at(-1)!.parts!.find(p => p.type === 'tool')!
    expect(step.type === 'tool' && step.call.confirmation?.state).toBe('rejected')
    expect(fs.existsSync(app.file(file))).toBe(true)
    expect(app.fake.requests).toHaveLength(count)
    expect(app.core.agent.records({ status: 'interrupted' }).total).toBe(1)
    app.fake.setResponder(agentScript([() => '手动重问完成']))
    const result = await ask(id, '忽略', undefined, recovered.messages[0]!.messageId)
    expect(result.text).toBe('手动重问完成')
    expect(app.core.agent.get(id).messages).toHaveLength(4)
  })
})

describe('库外路径与会话接续', () => {
  it('外部材料按完整原文引用，下一轮及重启沿用路径并回读；保存与导出保留可打开的来源', async () => {
    const absolute = path.join(app.tmp.dir, 'external', '材料 [原稿] #1%.md')
    const canonical = absolute.replace(/\\/g, '/')
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, '---\ncustom: 外部属性\n---\n第一轮的明确材料')
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: absolute } } }),
      results => '依据外部材料[^' + chunkIds(results[0]!)[0] + ']。',
    ]))
    const selected: AssistantContext = { agentId: 'default', strict: true, skillIds: [], references: [{ kind: 'file', value: canonical, title: '外部材料' }] }
    const id = app.core.agent.create().conversationId
    const first = await ask(id, '分析这个外部文件 ' + absolute, selected)
    expect(first.error).toBeUndefined()
    expect(first.citations).toMatchObject([{ valid: true, chunk: { path: canonical, lineStart: 1 } }])
    expect(first.toolCalls![0]!.output).toContain('custom: 外部属性')
    fs.writeFileSync(absolute, '第二轮外部文件的新内容')
    const second = await ask(id, '继续核对刚才的文件')
    expect(second.toolCalls![0]!.output).toContain('第二轮外部文件的新内容')
    expect(second.context?.references).toMatchObject(selected.references)
    await app.reopen({ removeIndex: true })
    const third = await ask(id, '重启后接着核对')
    expect(third.toolCalls![0]!.ok).toBe(true)
    expect(third.toolCalls![0]!.output).toContain('第二轮外部文件的新内容')
    expect(app.core.index.allPaths()).not.toContain(canonical)
    const open = vi.spyOn(app.platform, 'openExternal')
    const href = absoluteFileHref(canonical)
    await app.call('doc:openExternal', { path: href })
    expect(open).toHaveBeenCalledWith(absolute)
    const body = answerNoteBody(third.text, third.citations ?? [], 'content/工作')
    expect(body).toContain(href)
    expect(body).not.toContain('[^')
    const exported = renderConversation(app.core.agent.exportSnapshot(id), 'markdown', app.root, path.join(app.tmp.dir, 'exports', '对话.md'))
    expect(exported).toContain(encodeURI('../external/材料 [原稿] #1%.md').replace(/[?#()[\]]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()))
    await expect(app.call('doc:get', { ref: { path: absolute } })).rejects.toThrow('路径不在库内')
    await expect(app.call('doc:openExternal', { path: app.file('.jot/state.db') })).rejects.toThrow('专用管理操作')
  })
})

describe('外部移动后的材料接续', () => {
  it('严格材料随已知移动更新，本轮和下一轮读取新路径，历史出处保持原样', async () => {
    const original = 'content/工作/引用材料.md', outside = path.join(app.tmp.dir, 'external', '移动后.md')
    const target = outside.replace(/\\/g, '/')
    app.write(original, '明确材料的当前原文')
    const id = app.core.agent.create().conversationId
    const request: AssistantContext = { agentId: 'default', strict: true, skillIds: [], references: [{ kind: 'file', value: original, title: '引用材料' }] }
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: original } } }),
      results => '移动前材料[^' + chunkIds(results[0]!)[0] + ']。',
    ]))
    const before = await ask(id, '先核对', request)
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'move', arguments: { path: original, targetPath: outside } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: outside } } }),
      results => '移动后材料[^' + chunkIds(results[1]!)[0] + ']。',
    ]))
    const moved = await ask(id, '把这个文件移动到 ' + outside)
    expect(moved.toolCalls!.every(call => call.ok)).toBe(true)
    expect(moved.citations![0]!.chunk?.path).toBe(target)
    expect(app.core.agent.get(id).context?.references[0]?.value).toBe(target)
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'read', arguments: { path: outside } } }),
      results => '继续读取[^' + chunkIds(results[0]!)[0] + ']。',
    ]))
    const next = await ask(id, '继续刚才的文件')
    expect(next.toolCalls![0]!.ok).toBe(true)
    expect(next.citations![0]!.chunk?.path).toBe(target)
    expect(app.core.agent.get(id).messages[1]!.citations).toEqual(before.citations)
    expect(app.core.index.getDoc(original)).toBeNull()
  })
})

describe('工具参数纠正与完整诊断', () => {
  it('畸形流式JSON、外层字段、业务字段和执行错误分别记录；纠正后仅写一次，重启及导出保留原始失败输入', async () => {
    const title = '参数纠正后的笔记'
    const malformed = JSON.stringify({ operation: 'records.note', args: { title, body: '原始长正文。'.repeat(260) } }) + '意外附加文字'
    const id = app.core.agent.create().conversationId
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_manage', arguments: malformed } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.note' } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'records.note', args: { body: '缺少标题' } } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'pending.analyze', args: { path: 'content/工作/不存在.md' } } } }),
      () => ({ toolCall: { name: 'app_help', arguments: { name: 'records.note' } } }),
      results => {
        const example = JSON.parse(results[4]!)[0].example
        return { toolCall: { name: 'app_manage', arguments: { ...example, args: { ...example.args, title, body: '修正后唯一保存的正文', dir: 'content/工作' } } } }
      },
      results => ({ toolCall: { name: 'read', arguments: { path: JSON.parse(results[5]!).path } } }),
      results => '已核对保存结果[^' + chunkIds(results[6]!)[0] + ']。',
    ]))
    const result = await ask(id, '新建并核对笔记')
    expect(result.error).toBeUndefined()
    const calls = result.toolCalls!
    expect(calls.map(call => call.ok)).toEqual([false, false, false, false, true, true, true])
    expect(calls.slice(0, 4).map(call => call.errorKind)).toEqual(['json', 'validation', 'validation', 'execution'])
    expect(calls[0]).toMatchObject({ input: malformed, summary: expect.stringContaining('JSON 格式错误'), output: expect.stringContaining('Unexpected non-whitespace') })
    expect((calls[0]!.input as string).length).toBeGreaterThan(1300)
    expect(calls[0]!.input).toContain('意外附加文字')
    expect(calls[1]!.input).toEqual({ operation: 'records.note' })
    expect(calls[2]!.output).toContain('app_manage 完整调用示例')
    expect(calls[3]!.output).toContain('文件不存在')
    const saved = JSON.parse(calls[5]!.output!).path
    expect(fs.readFileSync(app.file(saved), 'utf8')).toContain('修正后唯一保存的正文')
    expect(app.core.index.allPaths().filter(path => path.includes(title))).toEqual([saved])
    expect(result.parts!.filter(part => part.type === 'tool')).toHaveLength(calls.length)
    expect(result.citations?.[0]?.valid).toBe(true)
    expect(events.filter(event => event.type === 'tool-end')).toHaveLength(calls.length)
    const exported = renderConversation(app.core.agent.exportSnapshot(id), 'jsonl', app.root, app.file('content/导出.jsonl'))
    expect(exported).toContain(JSON.stringify(malformed).slice(1, -1))
    await app.reopen()
    const restored = app.core.agent.get(id).messages.at(-1)!
    expect(restored.toolCalls![0]).toMatchObject({ input: malformed, errorKind: 'json' })
    expect(restored.toolCalls).toEqual(calls)
  })
})
