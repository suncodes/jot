import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capabilityCatalog } from '../../electron/agent/catalog'
import { createHandlers } from '../../electron/ipc/handlers'
import { dispatch } from '../../electron/ipc/register'
import { agentScript, chunkIds, isAgentRequest } from '../helpers/fake-llm'
import { answerNoteBody } from '../../shared/answer-note'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })

function plugin(id: string, options: { tool?: string; missingSkill?: boolean } = {}): string {
  const root = path.join(app.tmp.dir, id)
  fs.mkdirSync(path.join(root, 'agents/reviewer'), { recursive: true })
  fs.mkdirSync(path.join(root, 'skills/reading/references'), { recursive: true })
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1, id, name: '阅读插件 ' + id, description: '阅读模板',
    agents: [{ id: 'reviewer', name: '插件阅读助手', description: '复盘材料', skillIds: [id + ':' + (options.missingSkill ? 'absent' : 'reading')], toolIds: [options.tool ?? 'read'] }],
    skills: ['reading'],
  }))
  fs.writeFileSync(path.join(root, 'agents/reviewer/PROMPT.md'), '根据阅读技能完成任务')
  fs.writeFileSync(path.join(root, 'skills/reading/SKILL.md'), '---\nname: reading\ndescription: 阅读模板\nrequired_tools: [' + (options.tool ?? 'read') + ']\n---\n# 阅读做法\n读取 references/format.md。')
  fs.writeFileSync(path.join(root, 'skills/reading/references/format.md'), '模板字段：事实、出处与行动')
  return root
}
function handlers(source: string) {
  return createHandlers(app.core, { appInfo: () => ({ version: 'test', dev: true, platform: 'test' }),
    trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, pickDirectory: async purpose => { expect(purpose).toBe('plugin'); return source },
    saveFile: async () => null, hideCapture: () => {}, resizeCapture: () => {}, openExternal: async () => {} })
}
async function ask(agentId: string, skillId: string) {
  app.fake.setResponder(agentScript([
    () => ({ toolCall: { name: 'use_skill', arguments: { name: skillId, path: 'references/format.md' } } }),
    results => results[0]!,
  ]))
  const conversation = app.core.agent.create()
  const { runId } = app.core.agent.send(conversation.conversationId, '使用技能整理', { agentId, skillIds: [skillId], strict: false, references: [] })
  await app.core.agent.wait(runId)
  return app.core.agent.get(conversation.conversationId).messages.at(-1)!
}

describe('插件发现与实际运行', () => {
  it('周报组合包读取两目录、技能与模板，输出先审阅，用户保存后为独立笔记', async () => {
    const first = 'content/工作/项目甲/进展.md', second = 'content/工作/项目乙/进展.md'
    app.write(first, '---\ncreated: 2026-11-18\n---\n2026-11-18：项目甲完成接口联调。\n')
    app.write(second, '---\ncreated: 2026-11-19\n---\n2026-11-19：项目乙进行性能验证；下周安排压测。\n')
    await app.core.syncIndex()
    const before = await app.core.vault.listFiles()
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-review:weekly-report' } } }),
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-review:weekly-report', path: 'references/outline.md' } } }),
      () => ({ toolCall: { name: 'stats', arguments: { groupBy: 'folder' } } }),
      () => ({ toolCall: { name: 'timeline', arguments: { from: '2026-11-16', to: '2026-11-19' } } }),
      () => ({ toolCall: { name: 'search', arguments: { query: '进展' } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: first } } }),
      () => ({ toolCall: { name: 'read', arguments: { path: second } } }),
      results => '# 工作周报\n\n项目甲完成接口联调[^' + chunkIds(results[5]!)[0] + ']。\n项目乙进行性能验证，下周压测[^' + chunkIds(results[6]!)[0] + ']。',
    ]))
    const conversation = app.core.agent.create()
    const run = app.core.agent.send(conversation.conversationId, '按模板整理两项目进展', {
      agentId: 'default', skillIds: [], strict: true,
      references: [first, second].map(value => ({ kind: 'folder', value: path.posix.dirname(value), title: value })),
    })
    await app.core.agent.wait(run.runId)
    const message = app.core.agent.get(conversation.conversationId).messages.at(-1)!
    expect(message.error).toBeUndefined()
    expect(message.toolCalls?.every(call => call.ok)).toBe(true)
    expect(message.toolCalls?.[0]?.output).toContain('不自动写文件')
    expect(message.toolCalls?.[1]?.output).toContain('待补充信息')
    expect(message.toolCalls?.[3]?.output).toContain('不能据此推断当天进展')
    expect(message.citations?.map(cite => cite.chunk?.path).sort()).toEqual([first, second].sort())
    expect(await app.core.vault.listFiles()).toEqual(before)
    const request = app.fake.requests.find(isAgentRequest)!
    expect(JSON.stringify(request.messages)).toContain('普通问答、建议或草稿回答不写文件')
    const dir = 'content/工作/周报'
    const body = answerNoteBody(message.text, message.citations ?? [], dir)
    const saved = await app.call('doc:create', { dir, title: '本周工作', body })
    expect(saved.path).toBe(dir + '/本周工作.md')
    expect(fs.readFileSync(app.file(saved.path), 'utf8')).not.toContain('[^')
    expect((await app.call('links:list', { path: saved.path, direction: 'outgoing' })).map(link => link.path).sort()).toEqual([first, second].sort())
    await app.core.agent.delete(conversation.conversationId)
    expect((await app.call('doc:get', { ref: { path: saved.path } })).body).toBe(body)
  })

  it('预装能力来自相同清单和 Markdown，停用后默认助手退出对应技能', async () => {
    const catalog = await capabilityCatalog(app.core.vault, app.core.index)
    expect(catalog.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'work-review', source: 'bundled', enabled: true, issues: [] }), expect.objectContaining({ id: 'jot-core', source: 'bundled', enabled: true, issues: [] })]))
    expect(catalog.agents.map(agent => agent.id)).toEqual(['default'])
    const assistant = catalog.agents[0]!
    expect(assistant.name).toBe('通用助手')
    expect(assistant.skillIds).toContain('work-review:weekly-report')
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'work-review:weekly-report', path: 'references/outline.md' } } }),
      results => results[0]!,
    ]))
    const conversation = app.core.agent.create()
    const run = app.core.agent.send(conversation.conversationId, '按模板列出结构', { agentId: assistant.id, skillIds: [], strict: false, references: [] })
    await app.core.agent.wait(run.runId)
    const message = app.core.agent.get(conversation.conversationId).messages.at(-1)!
    expect(message.toolCalls?.[0]).toMatchObject({ ok: true, output: expect.stringContaining('本周完成') })
    const disabled = await app.call('capabilities:setPluginEnabled', { id: 'work-review', enabled: false })
    expect(disabled.agents.map(agent => agent.id)).toEqual(['default'])
    expect(disabled.agents[0]?.enabled).toBe(true)
    expect(disabled.agents[0]!.skillIds).not.toContain('work-review:weekly-report')
    await app.reopen()
    expect((await app.call('capabilities:catalog', undefined)).plugins.find(plugin => plugin.id === 'work-review')?.enabled).toBe(false)
  })

  it('外部目录预览、取消、安装、启用与重启，实际读取包内资源并完整复制技能', async () => {
    const source = plugin('reading-kit')
    const api = handlers(source)
    const cancelled = (await api['capabilities:previewPluginImport']())!
    await api['capabilities:cancelPluginImport']({ token: cancelled.token })
    await expect(api['capabilities:confirmPluginImport']({ token: cancelled.token })).rejects.toThrow('预览已失效')
    const preview = (await api['capabilities:previewPluginImport']())!
    expect(preview.issues).toEqual([])
    expect(fs.readdirSync(app.file('.jot/plugins'))).toEqual([])
    fs.writeFileSync(path.join(source, 'skills/reading/references/format.md'), '后续变化')
    const installed = await api['capabilities:confirmPluginImport']({ token: preview.token })
    expect(installed.plugins.find(plugin => plugin.id === preview.id)?.enabled).toBe(false)
    await app.call('capabilities:setPluginEnabled', { id: preview.id, enabled: true })
    await app.reopen()
    const message = await ask('reading-kit:reviewer', 'reading-kit:reading')
    expect(message.error).toBeUndefined()
    expect(message.text).toContain('事实、出处与行动')
    const catalog = await app.call('capabilities:catalog', undefined)
    const skill = catalog.skills.find(skill => skill.id === 'reading-kit:reading')!
    await app.call('capabilities:changeSkill', { action: 'save', copyFrom: skill.id,
      content: { name: 'reading-copy', title: skill.title, description: skill.description, body: skill.body, requiredTools: skill.requiredTools }, enabled: true })
    expect(await app.core.vault.skillFiles.read('reading-copy', 'references/format.md')).toContain('事实、出处与行动')
    await app.call('capabilities:setPluginEnabled', { id: 'reading-kit', enabled: false })
    const stopped = await ask('reading-kit:reviewer', 'reading-kit:reading')
    expect(stopped.error).toContain('智能体已停用')
  })

  it('手动放入库目录可刷新发现，包间依赖的停用和缺失均可诊断', async () => {
    const source = plugin('provider')
    fs.cpSync(source, app.file('.jot/plugins/provider'), { recursive: true })
    const consumer = plugin('consumer')
    const file = path.join(consumer, 'plugin.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.agents[0].skillIds = ['provider:reading']
    manifest.agents[0].toolIds = []
    fs.writeFileSync(file, JSON.stringify(manifest))
    fs.cpSync(consumer, app.file('.jot/plugins/consumer'), { recursive: true })
    const catalog = await app.call('capabilities:catalog', undefined)
    const issues = catalog.plugins.find(plugin => plugin.id === 'consumer')!.issues
    expect(issues).toContainEqual(expect.stringContaining('已停用'))
    expect(issues).toContainEqual(expect.stringContaining('未绑定技能所需工具'))
    expect(catalog.plugins.find(plugin => plugin.id === 'provider')?.enabled).toBe(false)
    await app.call('capabilities:setPluginEnabled', { id: 'provider', enabled: true })
    const enabled = await app.call('capabilities:catalog', undefined)
    expect(enabled.plugins.find(plugin => plugin.id === 'consumer')!.issues.some(issue => issue.includes('已停用'))).toBe(false)
    expect(enabled.agents[0]!.skillIds).toContain('provider:reading')
  })

  it('依赖缺失、移除及坏清单只影响相关能力；插件文件链接无法读取', async () => {
    const source = plugin('unavailable', { tool: 'remote_tool', missingSkill: true })
    const api = handlers(source)
    const preview = (await api['capabilities:previewPluginImport']())!
    expect(preview.issues).toEqual(expect.arrayContaining([expect.stringContaining('remote_tool'), expect.stringContaining('absent')]))
    await api['capabilities:confirmPluginImport']({ token: preview.token })
    await app.call('capabilities:setPluginEnabled', { id: 'unavailable', enabled: true })
    const catalog = await app.call('capabilities:catalog', undefined)
    expect(catalog.agents[0]!.skillIds).not.toContain('unavailable:reading')
    app.write('.jot/plugins/broken/plugin.json', '{broken')
    expect((await app.call('capabilities:catalog', undefined)).issues).toContainEqual(expect.stringContaining('broken/plugin.json'))
    const invalid = await dispatch(api, 'capabilities:setPluginEnabled', { id: '../outside', enabled: true })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    const outside = path.join(app.tmp.dir, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, app.file('.jot/plugins/linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await app.call('capabilities:catalog', undefined)).issues).toContainEqual(expect.stringContaining('linked/plugin.json'))
    fs.rmSync(app.file('.jot/plugins/unavailable'), { recursive: true })
    const removed = await app.call('capabilities:catalog', undefined)
    expect(removed.plugins.some(plugin => plugin.id === 'unavailable')).toBe(false)
    expect(removed.agents.some(agent => agent.id === 'unavailable:reviewer')).toBe(false)
  })
})
