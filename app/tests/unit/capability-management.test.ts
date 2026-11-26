import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/types'
import type { PluginDefinition } from '@shared/capabilities'
import { prepareTurn } from '../../electron/agent/context'
import { runOperation, type OperationContext } from '../../electron/agent/operations'
import { AgentFiles } from '../../electron/agent/files'
import { patchEntries } from '../../electron/operations/capabilities'
import { agentScript, isAgentRequest } from '../helpers/fake-llm'
import { deferred, testApp } from '../helpers/test-app'
let app: Awaited<ReturnType<typeof testApp>>
let events: AgentEvent[]
const content = (name = 'reader') => ({ name, title: '阅读', description: '核对事实', body: '读取原文再按模板回答。', requiredTools: ['read'] })
const skillText = (name = 'reader', body = '读取原文再按模板回答。') => '---\nname: ' + name + '\ndescription: 核对事实\nrequired_tools: [read]\n---\n' + body
const manifest = (id = 'reader-kit'): PluginDefinition => ({ schemaVersion: 1, id, name: id, description: '阅读插件',
  agents: [{ id: 'reader', name: '插件阅读', description: '核对事实', skillIds: [id + ':reader'], toolIds: ['read'] }], skills: ['reader'], requiredTools: [] })
async function createPlugin(id = 'reader-kit') {
  return app.call('capabilities:changePlugin', { action: 'save', manifest: manifest(id), files: [
    { path: 'agents/reader/PROMPT.md', content: '按模板核对。' },
    { path: 'skills/reader/SKILL.md', content: skillText() },
    { path: 'skills/reader/references/format.md', content: '原模板' },
  ], enabled: true })
}
async function ask(steps: Parameters<typeof agentScript>[0], id = app.core.agent.create().conversationId, agentId = 'default') {
  app.fake.setResponder(agentScript(steps))
  const { runId } = app.core.agent.send(id, '按明确要求管理能力', { agentId, references: [], strict: false, skillIds: [] })
  await app.core.agent.wait(runId)
  return app.core.agent.get(id).messages.at(-1)!
}
beforeEach(async () => { events = []; app = await testApp((name, data) => { if (name === 'agent:event') events.push(structuredClone(data as AgentEvent)) }) })
afterEach(async () => { vi.restoreAllMocks(); await app.close() })

describe('U3 能力自管理', () => {
  it('完整新配置与任务诊断；旧字段不回填，工具来源和启停真实展示', async () => {
    const catalog = await app.call('capabilities:catalog', undefined)
    expect(catalog.tools.every(tool => tool.enabled && tool.source === 'builtin')).toBe(true)
    expect(catalog.taskBindings).toHaveLength(4)
    expect(catalog.taskBindings.find(binding => binding.task === 'daily')?.issues).toEqual([])
    expect(catalog.taskBindings.every(binding => !binding.issues.length)).toBe(true)
    const fresh = await app.core.vault.getAssistantConfiguration()
    expect(fresh).toMatchObject({ disabledToolIds: [], disabledAgentIds: [] })
    const { disabledToolIds: _tools, disabledAgentIds: _agents, ...old } = fresh
    app.write('.jot/assistant.json', JSON.stringify(old))
    await expect(app.call('capabilities:catalog', undefined)).rejects.toThrow('配置无法读取')
    expect(JSON.parse(fs.readFileSync(app.file('.jot/assistant.json'), 'utf8'))).toEqual(old)
  })

  it('库内插件真实创建、编辑智能体和技能、单独启停、资源更新以及卸载保留引用', async () => {
    await createPlugin()
    await app.call('capabilities:changeSkill', { action: 'save', id: 'reader-kit:reader', content: { ...content(), body: '新的阅读规则' }, enabled: true })
    const catalog = await app.call('capabilities:catalog', undefined), agent = catalog.agents.find(agent => agent.id === 'reader-kit:reader')!
    await app.call('capabilities:changeAgent', { action: 'save', agent: { id: agent.id, name: '修改后的阅读', description: agent.description, instructions: '新的智能体规则', toolIds: agent.toolIds, skillIds: agent.skillIds, enabled: true } })
    await app.call('capabilities:patchResources', { owner: 'skill', id: 'reader-kit:reader', files: [{ path: 'references/format.md', content: '新模板' }] })
    expect(await app.call('capabilities:readResource', { owner: 'skill', id: 'reader-kit:reader', path: 'references/format.md' })).toBe('新模板')
    expect((await app.call('capabilities:resources', { owner: 'skill', id: 'reader-kit:reader' })).map(file => file.path)).toEqual(expect.arrayContaining(['SKILL.md', 'references/format.md']))
    await app.call('capabilities:setAgentEnabled', { id: 'reader-kit:reader', enabled: false })
    expect((await app.call('capabilities:catalog', undefined)).agents.find(agent => agent.id === 'reader-kit:reader')?.enabled).toBe(false)
    await app.call('capabilities:setAgentEnabled', { id: 'reader-kit:reader', enabled: true })
    const custom = { id: 'custom-reader', name: '独立阅读', description: '阅读', instructions: '核对', skillIds: ['reader-kit:reader'], toolIds: ['read'], enabled: true }
    await app.call('capabilities:changeAgent', { action: 'save', agent: custom })
    await app.call('capabilities:setTaskSkills', { daily: 'reader-kit:reader' })
    const impacts = await app.call('capabilities:impact', { owner: 'plugin', id: 'reader-kit' })
    expect(impacts).toContain('智能体：独立阅读'); expect(impacts).toContain('后台任务：daily')
    const removed = await app.call('capabilities:changePlugin', { action: 'remove', id: 'reader-kit' })
    expect(removed.agents.find(agent => agent.id === custom.id)?.skillIds).toEqual(['reader-kit:reader'])
    expect(removed.taskBindings.find(binding => binding.task === 'daily')?.issues).toContainEqual(expect.stringContaining('不存在'))
    await expect(prepareTurn(app.core.vault, app.core.index, { agentId: custom.id, skillIds: [], strict: false, references: [] })).rejects.toThrow('绑定技能')
    expect(fs.existsSync(app.file('.jot/plugins/reader-kit'))).toBe(false)
  })

  it('预装不可改，完整复制并替换自建与插件及任务引用，停用原能力，不改预装文件', async () => {
    const original = await app.call('capabilities:readResource', { owner: 'plugin', id: 'work-review', path: 'plugin.json' })
    await expect(app.call('capabilities:patchResources', { owner: 'plugin', id: 'work-review', files: [{ path: 'plugin.json', content: '{}' }] })).rejects.toThrow('预装')
    const tools = (await app.call('capabilities:catalog', undefined)).tools.filter(tool => !tool.loader).map(tool => tool.id)
    await app.call('capabilities:changeAgent', { action: 'save', agent: { id: 'reports', name: '报告', description: '写报告', instructions: '按技能', toolIds: tools, skillIds: ['work-review:weekly-report'], enabled: true } })
    await app.call('capabilities:setTaskSkills', { daily: 'work-review:weekly-report' })
    await app.call('capabilities:changePlugin', { action: 'copy', id: 'work-review', targetId: 'my-reviews', name: '自定义回顾', replaceReferences: true })
    const copied = await app.call('capabilities:catalog', undefined)
    expect(copied.plugins.find(plugin => plugin.id === 'work-review')?.enabled).toBe(false)
    expect(copied.agents.find(agent => agent.id === 'reports')?.skillIds).toEqual(['my-reviews:weekly-report'])
    expect(copied.taskBindings.find(binding => binding.task === 'daily')).toMatchObject({ skillId: 'my-reviews:weekly-report', issues: expect.arrayContaining([expect.stringContaining('后台任务不开放工具')]) })
    expect(await app.call('capabilities:readResource', { owner: 'plugin', id: 'work-review', path: 'plugin.json' })).toBe(original)
    expect(await app.call('capabilities:readResource', { owner: 'skill', id: 'my-reviews:weekly-report', path: 'references/outline.md' })).toContain('本周完成')
    await app.reopen({ removeIndex: true })
    expect((await app.call('capabilities:catalog', undefined)).taskBindings.find(binding => binding.task === 'daily')?.skillId).toBe('my-reviews:weekly-report')
  })

  it('独立技能完整复制含资源并替换绑定；删除后显示待修复，不阻塞普通助手', async () => {
    await app.call('capabilities:changeSkill', { action: 'save', content: content(), enabled: true })
    await app.call('capabilities:patchResources', { owner: 'skill', id: 'reader', files: [{ path: 'references/format.md', content: '配套模板' }] })
    await app.call('capabilities:changeAgent', { action: 'save', agent: { id: 'reading', name: '阅读自建', description: '阅读', instructions: '读取模板', toolIds: ['read'], skillIds: ['reader'], enabled: true } })
    await app.call('capabilities:setTaskSkills', { classify: 'reader' })
    await app.call('capabilities:changeSkill', { action: 'save', copyFrom: 'reader', replaceReferences: true, content: content('reader-copy'), enabled: true })
    const config = await app.core.vault.getAssistantConfiguration()
    expect(config.agents[0]?.skillIds).toEqual(['reader-copy'])
    expect(config.taskSkills.classify).toBe('reader-copy')
    expect(config.disabledSkillIds).toContain('reader')
    expect(await app.core.vault.skillFiles.read('reader-copy', 'references/format.md')).toBe('配套模板')
    await app.call('capabilities:changeSkill', { action: 'remove', id: 'reader-copy' })
    expect((await app.call('capabilities:catalog', undefined)).taskBindings.find(binding => binding.task === 'classify')?.issues).toContainEqual(expect.stringContaining('不存在'))
    expect((await prepareTurn(app.core.vault, app.core.index)).context.agent.enabled).toBe(true)
  })

  it('工具停用撤出下一轮工具集并给依赖诊断，启用可修复；不扩展只读智能体', async () => {
    await app.call('capabilities:changeSkill', { action: 'save', content: content(), enabled: true })
    await app.call('capabilities:setTaskSkills', { daily: 'reader' })
    await app.call('capabilities:setToolEnabled', { id: 'read', enabled: false })
    const catalog = await app.call('capabilities:catalog', undefined)
    expect(catalog.tools.find(tool => tool.id === 'read')?.enabled).toBe(false)
    expect(catalog.agents[0]?.skillIds).not.toContain('reader')
    expect(catalog.taskBindings.find(binding => binding.task === 'daily')?.issues).toContain('缺少工具：read')
    const reply = await ask([() => '好'])
    expect(reply.error).toBeUndefined()
    expect((app.fake.requests.find(isAgentRequest)?.tools as { function: { name: string } }[]).map(tool => tool.function.name)).not.toContain('read')
    await app.call('capabilities:setToolEnabled', { id: 'read', enabled: true })
    await app.call('capabilities:changeAgent', { action: 'save', agent: { id: 'readonly', name: '只读', description: '阅读', instructions: '只读', skillIds: ['reader'], toolIds: ['read'], enabled: true } })
    await ask([() => '只读'], app.core.agent.create().conversationId, 'readonly')
    expect((app.fake.requests.filter(isAgentRequest).at(-1)!.tools as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['read', 'use_skill'])
  })

  it('清单损坏、声明资源缺失、越界或大小写重名均不修改原包，替换失败恢复原目录', async () => {
    await createPlugin()
    const before = await app.core.vault.pluginFiles.read('reader-kit')
    for (const files of [
      [{ path: 'plugin.json', content: '{}' }],
      [{ path: 'skills/reader/SKILL.md', content: null }],
      [{ path: '../outside.md', content: '越界' }],
      [{ path: 'A.md', content: '甲' }, { path: 'a.md', content: '乙' }],
    ]) await expect(app.call('capabilities:patchResources', { owner: 'plugin', id: 'reader-kit', files })).rejects.toThrow()
    expect(await app.core.vault.pluginFiles.read('reader-kit')).toBe(before)
    const rename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith(path.sep + 'next')) throw new Error('模拟替换失败')
      return rename(from, to)
    })
    await expect(app.call('capabilities:patchResources', { owner: 'plugin', id: 'reader-kit', files: [{ path: 'skills/reader/references/format.md', content: '不会保存' }] })).rejects.toThrow('模拟替换失败')
    expect(await app.core.vault.pluginFiles.read('reader-kit', 'skills/reader/references/format.md')).toBe('原模板')
    expect(patchEntries([{ path: 'asset.bin', data: Buffer.from([0, 255]) }], [{ path: 'new.md', content: '新文本' }])[0]?.data).toEqual(Buffer.from([0, 255]))
  })

  it('插件和技能更新采用预览快照、完整替换资源，保留启停及绑定；取消预览不写入', async () => {
    await createPlugin()
    const root = path.join(app.tmp.dir, 'updated-kit')
    fs.cpSync(app.file('.jot/plugins/reader-kit'), root, { recursive: true })
    fs.writeFileSync(path.join(root, 'skills/reader/references/format.md'), '更新模板')
    fs.writeFileSync(path.join(root, 'new.md'), '新增')
    app.core.capabilities.setPlatform({ appInfo: () => ({ version: 'test', dev: true, platform: 'test' }), pickDirectory: async () => root,
      trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, saveFile: async () => null, hideCapture() {}, resizeCapture() {}, openExternal: async () => {} })
    const preview = await app.core.capabilities.importPreview('plugin', 'reader-kit')
    expect(preview?.updating).toBe('reader-kit')
    fs.writeFileSync(path.join(root, 'skills/reader/references/format.md'), '预览后改动')
    await app.core.capabilities.importConfirm('plugin', preview!.token)
    expect(await app.core.vault.pluginFiles.read('reader-kit', 'skills/reader/references/format.md')).toBe('更新模板')
    expect((await app.core.capabilities.catalog()).plugins.find(plugin => plugin.id === 'reader-kit')?.enabled).toBe(true)
    await app.call('capabilities:changeSkill', { action: 'save', content: content('independent'), enabled: true })
    const source = path.join(app.tmp.dir, 'skill-update'); fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'SKILL.md'), skillText('independent', '更新后的做法'))
    app.core.capabilities.setPlatform({ appInfo: () => ({ version: 'test', dev: true, platform: 'test' }), pickDirectory: async () => source,
      trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, saveFile: async () => null, hideCapture() {}, resizeCapture() {}, openExternal: async () => {} })
    const skillPreview = await app.core.capabilities.importPreview('skill', 'independent')
    await app.core.capabilities.importConfirm('skill', skillPreview!.token, 'independent')
    expect(await app.core.vault.skillFiles.read('independent')).toContain('更新后的做法')
    const cancelled = await app.core.capabilities.importPreview('skill', 'independent', undefined, source)
    app.core.capabilities.importCancel('skill', cancelled!.token)
    await expect(app.core.capabilities.importConfirm('skill', cancelled!.token, 'independent')).rejects.toThrow('失效')
  })

  it('在途读技能资源沿用启动版本；更新、停用和卸载只影响下一轮，不依赖内容索引', async () => {
    await createPlugin()
    const entered = deferred(), release = deferred(), id = app.core.agent.create().conversationId
    app.fake.setResponder(agentScript([
      async () => { entered.release(); await release.promise; return { toolCall: { name: 'use_skill', arguments: { name: 'reader-kit:reader', path: 'references/format.md' } } } },
      results => results[0]!,
    ]))
    const { runId } = app.core.agent.send(id, '读取模板')
    await entered.promise
    await app.call('capabilities:patchResources', { owner: 'plugin', id: 'reader-kit', files: [{ path: 'skills/reader/references/format.md', content: '新模板' }] })
    await app.call('capabilities:changePlugin', { action: 'remove', id: 'reader-kit' })
    release.release()
    await app.core.agent.wait(runId)
    expect(app.core.agent.get(id).messages.at(-1)?.text).toBe('原模板')
    const next = await ask([() => ({ toolCall: { name: 'use_skill', arguments: { name: 'reader-kit:reader' } } }), () => '无此技能'], id)
    expect(next.toolCalls?.[0]).toMatchObject({ ok: false })
  })

  it('通用助手创建技能后本轮不可暗中扩绑定，下一轮真正加载；能力操作与确认进入真实记录', async () => {
    const id = app.core.agent.create().conversationId
    const create = await ask([
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.skill', args: { action: 'save', content: content('assistant-created'), enabled: true } } } }),
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'assistant-created' } } }),
      () => '下轮可用',
    ], id)
    expect(create.toolCalls?.map(tool => tool.ok)).toEqual([true, false])
    const next = await ask([() => ({ toolCall: { name: 'use_skill', arguments: { name: 'assistant-created' } } }), results => results[0]!], id)
    expect(next.text).toContain('读取原文')
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.skill', args: { action: 'remove', id: 'assistant-created' } } } }),
      () => '已处理',
    ]))
    const { runId } = app.core.agent.send(id, '删除刚才技能')
    await expect.poll(() => events.find(event => event.type === 'tool-update' && event.call.confirmation?.state === 'pending'), { timeout: 10000 }).toBeDefined()
    const event = events.find(event => event.type === 'tool-update' && event.call.confirmation?.state === 'pending') as Extract<AgentEvent, { type: 'tool-update' }>
    app.core.agent.confirm(runId, event.call.confirmation!.id, false)
    await app.core.agent.wait(runId)
    expect(fs.existsSync(app.file('.jot/skills/assistant-created/SKILL.md'))).toBe(true)
  })

  it('插件编辑和资源补丁共用覆盖／删除确认；取消、停止及严格材料不会产生能力副作用', async () => {
    await createPlugin()
    const files = new AgentFiles({ vault: app.core.vault, index: app.core.index, operations: () => app.core.operations,
      mutate: operation => app.core.mutate(operation), changed: () => app.core.idle(), moved: paths => app.core.agent.moveReferences(paths), trashed: () => {} })
    const confirm = vi.fn(async () => false)
    const context: OperationContext = { app: app.core.operations, files, scope: {}, conversationId: app.core.agent.create().conversationId, confirm }
    const patch = [{ path: 'skills/reader/references/format.md', content: '新的模板' }]
    const calls = [
      ['capabilities.edit-resources', { owner: 'plugin', id: 'reader-kit', files: patch }],
      ['capabilities.plugin', { action: 'save', id: 'reader-kit', manifest: manifest(), files: patch, enabled: true }],
    ] as const
    for (const [operation, args] of calls) await expect(runOperation(operation, args, context)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(await app.core.vault.pluginFiles.read('reader-kit', patch[0]!.path)).toBe('原模板')
    context.confirm = async () => true
    await runOperation(calls[1][0], calls[1][1], context)
    expect(await app.core.vault.pluginFiles.read('reader-kit', patch[0]!.path)).toBe('新的模板')
    const source = path.join(app.tmp.dir, 'explicit-source'); fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'SKILL.md'), skillText('explicit-import'))
    const preview = await runOperation('capabilities.import-preview', { owner: 'skill', source }, context) as { token: string }
    expect(preview.token).toBeTruthy()
    await runOperation('capabilities.import-confirm', { owner: 'skill', token: preview.token, name: 'explicit-import' }, context)
    expect(await app.core.vault.skillFiles.read('explicit-import')).toContain('读取原文')
    context.scope = { materials: [{ kind: 'folder', value: 'content/工作' }] }
    await expect(runOperation('capabilities.list', { kind: 'skill' }, context)).rejects.toMatchObject({ code: 'WRITE_DENIED' })
    context.scope = {}; const controller = new AbortController(); controller.abort(); context.signal = controller.signal
    await expect(runOperation('capabilities.tool-enable', { id: 'read', enabled: false }, context)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect((await app.core.capabilities.catalog()).tools.find(tool => tool.id === 'read')?.enabled).toBe(true)
  })

  it('导入更新先校验声明资源，坏包不替换原版；包内智能体绑定遵循相同校验', async () => {
    await createPlugin()
    const root = path.join(app.tmp.dir, 'broken-update')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify(manifest()))
    app.core.capabilities.setPlatform({ appInfo: () => ({ version: 'test', dev: true, platform: 'test' }), pickDirectory: async () => root,
      trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, saveFile: async () => null, hideCapture() {}, resizeCapture() {}, openExternal: async () => {} })
    await expect(app.core.capabilities.importPreview('plugin', 'reader-kit')).rejects.toThrow('声明')
    expect(await app.core.vault.pluginFiles.read('reader-kit', 'skills/reader/references/format.md')).toBe('原模板')
    const agent = (await app.core.capabilities.catalog()).agents.find(agent => agent.id === 'reader-kit:reader')!
    const { pluginId: _pluginId, ...configuration } = agent
    await expect(app.call('capabilities:changeAgent', { action: 'save', agent: { ...configuration, toolIds: [] } })).rejects.toThrow('缺少技能所需工具')
    expect((await app.core.capabilities.catalog()).agents.find(item => item.id === agent.id)?.toolIds).toEqual(['read'])
  })

  it('系统目录选择期间切库或停止，迟到结果不保存预览或安装到新库', async () => {
    await createPlugin()
    const picked = deferred(), source = app.file('.jot/plugins/reader-kit')
    app.core.capabilities.setPlatform({ appInfo: () => ({ version: 'test', dev: true, platform: 'test' }), pickDirectory: async () => { await picked.promise; return source },
      trashItem: async () => { throw new Error('未配置系统回收站测试') }, pickFiles: async () => null, saveFile: async () => null, hideCapture() {}, resizeCapture() {}, openExternal: async () => {} })
    const pending = app.core.capabilities.importPreview('plugin')
    const result = expect(pending).rejects.toThrow('库已切换')
    await app.core.openVault(path.join(app.tmp.dir, '另一个虚构库'), true)
    picked.release(); await result
    expect((await app.core.capabilities.catalog()).plugins.some(plugin => plugin.id === 'reader-kit')).toBe(false)
    const controller = new AbortController(); controller.abort()
    await expect(app.core.capabilities.importPreview('plugin', undefined, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
