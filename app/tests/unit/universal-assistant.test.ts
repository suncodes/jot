import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAssistantConfiguration } from '../../shared/capabilities'
import { DEFAULT_TASK_SKILLS } from '../../shared/ai-tasks'
import { agentChange, assistantConfiguration, pluginManifest } from '../../electron/agent/capability-schema'
import { prepareTurn } from '../../electron/agent/context'
import { agentScript, isAgentRequest } from '../helpers/fake-llm'
import { testApp } from '../helpers/test-app'

let app: Awaited<ReturnType<typeof testApp>>
beforeEach(async () => { app = await testApp() })
afterEach(async () => { await app.close() })

describe('U1 通用助手和目标配置', () => {
  it('新库只有通用助手，保留工作技能且查询不落配置；不为旧专项助手提供名称映射', async () => {
    const catalog = await app.call('capabilities:catalog', undefined)
    expect(catalog.agents.map(agent => ({ id: agent.id, name: agent.name }))).toEqual([{ id: 'default', name: '通用助手' }])
    expect(catalog.agents[0]!.skillIds).toEqual(expect.arrayContaining(['work-review:weekly-report', 'work-review:project-progress']))
    expect(catalog.agents[0]!.toolIds).toEqual(catalog.tools.filter(tool => !tool.loader).map(tool => tool.id))
    expect(catalog.plugins[0]!.agentIds).toEqual([])
    expect(await app.core.vault.getAssistantConfiguration()).toEqual(createAssistantConfiguration())
    expect(DEFAULT_TASK_SKILLS).toEqual({
      daily: 'jot-core:daily-review', 'summarize-file': 'jot-core:source-summary',
      classify: 'jot-core:content-organize', 'find-synonyms': 'jot-core:term-organize',
    })
    expect(fs.existsSync(app.file('.jot/assistant.json'))).toBe(false)
    expect(app.fake.requests).toHaveLength(0)
    await expect(prepareTurn(app.core.vault, app.core.index, {
      agentId: 'work-review:weekly', references: [], strict: false, skillIds: [],
    })).rejects.toThrow('停用或删除')
  })

  it('做事说明下一轮生效，完整目标配置落盘和重启；通用助手不能被停用或替换绑定', async () => {
    const first = await prepareTurn(app.core.vault, app.core.index)
    const instructions = '根据当前资料回答，结尾写“已核对依据”。'
    const catalog = await app.call('capabilities:changeAgent', { action: 'configure-default', instructions })
    expect(catalog.agents[0]!.instructions).toBe(instructions)
    expect(first.context.agent.instructions).not.toBe(instructions)
    const stored = JSON.parse(fs.readFileSync(app.file('.jot/assistant.json'), 'utf8'))
    expect(stored).toEqual({ ...createAssistantConfiguration(), defaultInstructions: instructions })
    expect(assistantConfiguration.safeParse(stored).success).toBe(true)
    await expect(app.call('capabilities:changeAgent', { action: 'remove', id: 'default' })).rejects.toThrow('INVALID_INPUT')
    await expect(app.call('capabilities:changeAgent', { action: 'save', agent: { ...catalog.agents[0]!, enabled: false } })).rejects.toThrow('INVALID_INPUT')
    app.fake.setResponder(agentScript([() => '已核对依据']))
    const conversation = app.core.agent.create()
    const run = app.core.agent.send(conversation.conversationId, '说明你的回答方式')
    await app.core.agent.wait(run.runId)
    expect(app.core.agent.get(conversation.conversationId).messages.at(-1)?.error).toBeUndefined()
    expect(JSON.stringify(app.fake.requests.find(isAgentRequest)?.messages)).toContain(instructions)
    await app.reopen()
    expect((await app.call('capabilities:catalog', undefined)).agents[0]!.instructions).toBe(instructions)
  })

  it('包内技能可独立启停并跨重启保存，包启停仍决定整体可用性', async () => {
    const id = 'work-review:weekly-report'
    const disabled = await app.call('capabilities:changeSkill', { action: 'enable', id, enabled: false })
    expect(disabled.skills.find(skill => skill.id === id)?.enabled).toBe(false)
    expect(disabled.agents[0]!.skillIds).not.toContain(id)
    expect(disabled.agents[0]!.skillIds).toContain('work-review:project-progress')
    await app.reopen()
    expect((await app.call('capabilities:catalog', undefined)).skills.find(skill => skill.id === id)?.enabled).toBe(false)
    await app.call('capabilities:changeSkill', { action: 'enable', id, enabled: true })
    await app.call('capabilities:setPluginEnabled', { id: 'work-review', enabled: false })
    const inactive = await app.call('capabilities:changeSkill', { action: 'enable', id, enabled: true })
    expect(inactive.skills.find(skill => skill.id === id)?.enabled).toBe(false)
    const enabled = await app.call('capabilities:setPluginEnabled', { id: 'work-review', enabled: true })
    expect(enabled.agents[0]!.skillIds).toContain(id)
    expect(enabled.agents.map(agent => agent.id)).toEqual(['default'])
  })

  it('停用包内技能会显示本包智能体的真实依赖问题，不误报尚未启用的完整包', async () => {
    app.write('.jot/plugins/reader-kit/plugin.json', JSON.stringify({
      schemaVersion: 1, id: 'reader-kit', name: '阅读', description: '核对阅读材料',
      agents: [{ id: 'reader', name: '阅读助手', description: '读取材料', skillIds: ['reader-kit:reading'], toolIds: ['read'] }],
      skills: ['reading'],
    }))
    app.write('.jot/plugins/reader-kit/agents/reader/PROMPT.md', '按阅读技能核对材料')
    app.write('.jot/plugins/reader-kit/skills/reading/SKILL.md', '---\nname: reading\ndescription: 阅读材料\nrequired_tools: [read]\n---\n# 阅读\n读取原文。')
    const discovered = await app.call('capabilities:catalog', undefined)
    expect(discovered.plugins.find(plugin => plugin.id === 'reader-kit')?.issues).toEqual([])
    await app.call('capabilities:setPluginEnabled', { id: 'reader-kit', enabled: true })
    const stopped = await app.call('capabilities:changeSkill', { action: 'enable', id: 'reader-kit:reading', enabled: false })
    expect(stopped.plugins.find(plugin => plugin.id === 'reader-kit')?.issues).toContainEqual(expect.stringContaining('依赖的技能已停用'))
    expect(stopped.agents[0]!.skillIds).not.toContain('reader-kit:reading')
    await expect(prepareTurn(app.core.vault, app.core.index, {
      agentId: 'reader-kit:reader', references: [], strict: false, skillIds: [],
    })).rejects.toThrow('绑定技能已停用')
    const restored = await app.call('capabilities:changeSkill', { action: 'enable', id: 'reader-kit:reading', enabled: true })
    expect(restored.plugins.find(plugin => plugin.id === 'reader-kit')?.issues).toEqual([])
  })

  it('新配置严格要求完整字段，不读取旧格式回填或覆盖；任务引用必须是有效技能标识', async () => {
    const fresh = createAssistantConfiguration()
    expect(assistantConfiguration.safeParse(fresh).success).toBe(true)
    for (const invalid of [
      { agents: [], disabledSkillIds: [], enabledVaultPluginIds: [], disabledBundledPluginIds: [] },
      { ...fresh, taskSkills: {} },
      { ...fresh, taskSkills: { ...fresh.taskSkills, daily: '../outside' } },
      { ...fresh, disabledSkillIds: ['pkg:invalid:skill'] },
    ]) {
      expect(assistantConfiguration.safeParse(invalid).success).toBe(false)
    }
    const original = JSON.stringify({ agents: [], disabledSkillIds: [], enabledVaultPluginIds: [], disabledBundledPluginIds: [] })
    fs.writeFileSync(app.file('.jot/assistant.json'), original)
    await expect(app.call('capabilities:catalog', undefined)).rejects.toThrow('智能体配置无法读取')
    expect(fs.readFileSync(app.file('.jot/assistant.json'), 'utf8')).toBe(original)
  })

  it('工具绑定不受旧 20 项限制，仍拒绝空名称和重复工具；可创建第二个智能体', async () => {
    const tools = Array.from({ length: 32 }, (_, i) => 'tool_' + i)
    const agent = { id: 'reader', name: '阅读助手', description: '阅读当前资料', instructions: '读取后再回答', skillIds: [], toolIds: tools, enabled: true }
    expect(agentChange.safeParse({ action: 'save', agent }).success).toBe(true)
    expect(pluginManifest.safeParse({ schemaVersion: 1, id: 'reader-kit', name: '阅读', description: '阅读资料', agents: [{ id: agent.id, name: agent.name, description: agent.description, skillIds: agent.skillIds, toolIds: tools }] }).success).toBe(true)
    for (const toolIds of [['read', 'read'], ['']]) {
      expect(agentChange.safeParse({ action: 'save', agent: { ...agent, toolIds } }).success).toBe(false)
    }
    const catalog = await app.call('capabilities:changeAgent', { action: 'save', agent: { ...agent, toolIds: ['read'] } })
    expect(catalog.agents.map(item => item.id)).toEqual(['default', 'reader'])
  })
})
