import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssistantContext } from '@shared/assistant'
import { prepareTurn } from '../../electron/agent/context'
import { agentScript, chunkIds, isAgentRequest } from '../helpers/fake-llm'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })
const first = 'content/工作/甲/预算.md', second = 'content/工作/乙/预算.md'
const output = 'content/工作/材料简报.md'
const context: AssistantContext = { agentId: 'default', strict: true, skillIds: [], references: [
  { kind: 'folder', value: 'content/工作/甲', title: '甲' }, { kind: 'folder', value: 'content/工作/乙', title: '乙' },
] }
async function sources() {
  app.write(first, '方案甲预算为0.1万元，已完成接口验证。')
  app.write(second, '方案乙预算为0.2万元，还在讨论，不代表已完成。')
  app.write('content/生活/范围外.md', '不应带入的私密材料')
  await app.core.syncIndex()
}
async function ask(text: string, selection?: AssistantContext, id = app.core.agent.create().conversationId) {
  const { runId } = app.core.agent.send(id, text, selection)
  await app.core.agent.wait(runId)
  return { id, answer: app.core.agent.get(id).messages.at(-1)! }
}
const brief = (results: string[], start = 2) => '甲预算0.1万元[^' + chunkIds(results[start]!)[0] + ']，乙预算0.2万元[^'
  + chunkIds(results[start + 1]!)[0] + ']，合计' + JSON.parse(results[start + 2]!).result + '万元；乙仍在讨论。'
const readSteps = (skill: string, reference: string) => [
  () => ({ toolCall: { name: 'use_skill', arguments: { name: skill } } }),
  () => ({ toolCall: { name: 'use_skill', arguments: { name: skill, path: reference } } }),
  () => ({ toolCall: { name: 'read', arguments: { path: first } } }),
  () => ({ toolCall: { name: 'read', arguments: { path: second } } }),
  () => ({ toolCall: { name: 'calculator', arguments: { expression: '0.1+0.2' } } }),
] as Parameters<typeof agentScript>[0]

describe('U6 实用技能及计算工具', () => {
  it('预装包三项技能及真实配套资源可加载，不增Agent或后台绑定；本地依赖逐项核验', async () => {
    const catalog = await app.call('capabilities:catalog', undefined)
    expect(catalog.agents.map(agent => agent.id)).toEqual(['default'])
    const pkg = catalog.plugins.find(pkg => pkg.id === 'jot-productivity')!
    expect(pkg).toMatchObject({ enabled: true, agentIds: [], issues: [], source: 'bundled' })
    expect(pkg.skillIds).toHaveLength(3)
    for (const id of pkg.skillIds) {
      const skill = catalog.skills.find(skill => skill.id === id)!
      expect(catalog.agents[0]!.skillIds).toContain(id)
      expect(skill.requiredTools?.every(tool => catalog.tools.some(entry => entry.id === tool && entry.enabled))).toBe(true)
      const relative = 'references/' + (skill.name === 'skill-manager' ? 'actions' : skill.name === 'research-brief' ? 'evidence' : 'outline') + '.md'
      expect((await app.call('capabilities:readResource', { owner: 'skill', id, path: relative })).length).toBeGreaterThan(100)
    }
    expect(catalog.tools.find(tool => tool.id === 'calculator')).toMatchObject({ access: 'read', enabled: true, source: 'builtin', loader: false })
    expect(catalog.taskBindings.every(binding => !binding.issues.length && binding.skillId.startsWith('jot-core:'))).toBe(true)
    expect(await app.core.vault.listFiles()).toEqual([])
    expect(app.fake.requests).toHaveLength(0)
  })

  it('两份限定原文真实读取、技能及参考加载、十进制计算和出处持久化，普通简报不写文件', async () => {
    await sources()
    const before = await app.core.vault.listFiles()
    app.fake.setResponder(agentScript([...readSteps('jot-productivity:research-brief', 'references/evidence.md'), results => brief(results)]))
    const { id, answer } = await ask('比较两份预算，给出合计和已验证／讨论的区别，只回答。', context)
    expect(answer.error).toBeUndefined()
    expect(answer.text).toContain('合计0.3万元')
    expect(answer.toolCalls!.every(call => call.ok)).toBe(true)
    expect(answer.toolCalls!.map(call => call.name)).toEqual(['use_skill', 'use_skill', 'read', 'read', 'calculator'])
    expect(answer.citations!.map(cite => cite.chunk?.path).sort()).toEqual([first, second].sort())
    expect(answer.citations!.every(cite => cite.valid)).toBe(true)
    expect(JSON.stringify(app.fake.requests.filter(isAgentRequest))).not.toContain('不应带入的私密材料')
    expect(await app.core.vault.listFiles()).toEqual(before)
    await app.reopen()
    expect(app.core.agent.get(id).messages.at(-1)?.toolCalls).toEqual(answer.toolCalls)
    expect(app.core.agent.get(id).messages.at(-1)?.citations).toEqual(answer.citations)
  })

  it('明确要求保存知识梳理时写入独立普通笔记和相对来源，删除会话后原文与成果均保留', async () => {
    await sources()
    const body = '# 知识梳理\n\n甲已验证、乙仍在讨论，预算合计0.3万元。\n\n[甲预算](甲/预算.md) · [乙预算](乙/预算.md)'
    app.fake.setResponder(agentScript([
      ...readSteps('jot-productivity:knowledge-organize', 'references/outline.md'),
      () => ({ toolCall: { name: 'write_files', arguments: { files: [{ path: output, body }] } } }),
      () => '已保存：' + output,
    ]))
    const { id, answer } = await ask('将两份材料梳理并保存到' + output + '，保留原文。', context)
    expect(answer.error).toBeUndefined()
    expect(answer.toolCalls!.every(call => call.ok)).toBe(true)
    const saved = fs.readFileSync(app.file(output), 'utf8')
    expect(saved).toContain('[甲预算](甲/预算.md)')
    expect(saved).not.toMatch(/\[\^[a-f0-9]{6}\]/)
    expect((await app.call('doc:resolveLink', { from: output, target: '甲/预算.md', kind: 'markdown' })).path).toBe(first)
    expect((await app.call('doc:resolveLink', { from: output, target: '乙/预算.md', kind: 'markdown' })).path).toBe(second)
    await app.call('agent:delete', { conversationId: id })
    expect(fs.readFileSync(app.file(output), 'utf8')).toBe(saved)
    expect(fs.readFileSync(app.file(first), 'utf8')).toBe('方案甲预算为0.1万元，已完成接口验证。')
  })

  it('计算错误留真实失败步骤，模型可改算式继续；工具停用真实移出下一轮请求', async () => {
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'calculator', arguments: { expression: '1/0' } } }),
      () => ({ toolCall: { name: 'calculator', arguments: { expression: 'round(10/3,2)' } } }),
      results => '首式不能除零，改式得' + JSON.parse(results[1]!).result,
    ]))
    const { answer } = await ask('计算并复核')
    expect(answer.toolCalls).toMatchObject([{ name: 'calculator', ok: false, output: expect.stringContaining('不能除以零') }, { name: 'calculator', ok: true }])
    expect(answer.text).toContain('3.33')
    await app.call('capabilities:setToolEnabled', { id: 'calculator', enabled: false })
    app.fake.setResponder(agentScript([() => '当前计算工具已停用'])) 
    await ask('再核算')
    expect((app.fake.requests.filter(isAgentRequest).at(-1)!.tools as { function: { name: string } }[]).some(tool => tool.function.name === 'calculator')).toBe(false)
    await app.reopen()
    expect((await app.call('capabilities:catalog', undefined)).tools.find(tool => tool.id === 'calculator')?.enabled).toBe(false)
  })

  it('缺依赖技能不自动绑定，预装包停用／恢复跨重启，后台不会误用交互技能', async () => {
    await app.call('capabilities:setToolEnabled', { id: 'search', enabled: false })
    const catalog = await app.call('capabilities:catalog', undefined)
    expect(catalog.agents[0]!.skillIds).not.toContain('jot-productivity:research-brief')
    expect(catalog.agents[0]!.skillIds).not.toContain('jot-productivity:knowledge-organize')
    expect(catalog.agents[0]!.skillIds).toContain('jot-productivity:skill-manager')
    await app.call('capabilities:setToolEnabled', { id: 'search', enabled: true })
    const bindings = await app.call('capabilities:setTaskSkills', { daily: 'jot-productivity:research-brief' })
    expect(bindings.taskBindings.find(binding => binding.task === 'daily')?.issues).toContainEqual(expect.stringContaining('后台任务不开放工具'))
    await app.call('capabilities:setTaskSkills', { daily: 'jot-core:daily-review' })
    await app.call('capabilities:setPluginEnabled', { id: 'jot-productivity', enabled: false })
    await app.reopen()
    expect((await app.call('capabilities:catalog', undefined)).agents[0]!.skillIds.some(id => id.startsWith('jot-productivity:'))).toBe(false)
    await app.call('capabilities:setPluginEnabled', { id: 'jot-productivity', enabled: true })
    expect((await prepareTurn(app.core.vault, app.core.index)).skills.filter(skill => skill.pluginId === 'jot-productivity')).toHaveLength(3)
  })

  it('加载技能管理指引后使用正式操作创建技能，下一轮可加载配套资源，不要求重启', async () => {
    const created = 'u6-reading'
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:skill-manager' } } }),
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:skill-manager', path: 'references/actions.md' } } }),
      () => ({ toolCall: { name: 'app_help', arguments: { group: 'capabilities' } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.skill', args: { action: 'save',
        content: { name: created, title: '阅读提纲', description: '整理当前阅读资料', body: '根据references/format.md整理事实与出处。', requiredTools: ['read'] }, enabled: true } } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.edit-resources', args: { owner: 'skill', id: created, files: [{ path: 'references/format.md', content: '观点、依据、疑问' }] } } } }),
      () => '技能已保存，下次提问生效。',
    ]))
    const { id, answer } = await ask('创建一个阅读提纲技能，保留观点、依据和疑问。')
    expect(answer.toolCalls!.every(call => call.ok)).toBe(true)
    expect(fs.readFileSync(app.file('.jot/skills/' + created + '/SKILL.md'), 'utf8')).toContain('阅读提纲')
    expect(answer.context?.skills.some(skill => skill.id === created)).toBe(false)
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: created, path: 'references/format.md' } } }),
      results => results[0]!,
    ]))
    const next = await ask('使用刚建的提纲', undefined, id)
    expect(next.answer.text).toContain('观点、依据、疑问')
    expect(next.answer.toolCalls![0]?.ok).toBe(true)
  })

  it('技能管理指引支持现有本地目录预览／实际安装，来源模板可在下一轮读取', async () => {
    const source = path.join(app.tmp.dir, 'external-reading')
    fs.mkdirSync(path.join(source, 'references'), { recursive: true })
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: external-reading\ndescription: 根据本地资料阅读\nrequired_tools: [read]\n---\n# 本地阅读\n使用references/format.md。')
    fs.writeFileSync(path.join(source, 'references/format.md'), '阅读内容、证据和待确认点')
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'jot-productivity:skill-manager' } } }),
      () => ({ toolCall: { name: 'app_help', arguments: { operation: 'capabilities.import-preview' } } }),
      () => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.import-preview', args: { owner: 'skill', source } } } }),
      results => ({ toolCall: { name: 'app_manage', arguments: { operation: 'capabilities.import-confirm', args: { owner: 'skill', token: JSON.parse(results[2]!).token, name: 'external-reading', enabled: true } } } }),
      () => '已导入本地技能。',
    ]))
    const { id, answer } = await ask('安装明确提供的技能目录：' + source)
    expect(answer.toolCalls!.every(call => call.ok)).toBe(true)
    app.fake.setResponder(agentScript([
      () => ({ toolCall: { name: 'use_skill', arguments: { name: 'external-reading', path: 'references/format.md' } } }),
      results => results[0]!,
    ]))
    expect((await ask('核对刚安装的资源', undefined, id)).answer.text).toContain('阅读内容、证据和待确认点')
  })
})
