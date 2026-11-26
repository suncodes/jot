import { AI_TASK_KINDS } from '@shared/ai-tasks'
import { GENERAL_ASSISTANT_NAME, missingSkillTools, taskToolProblems, type AgentChange, type AgentConfiguration, type AssistantConfiguration, type CapabilityCatalog, type ManagedAgent, type ManagedSkill } from '@shared/capabilities'
import { JotError } from '@shared/result'
import type { IndexService } from '../index/index'
import type { VaultService } from '../vault/vault'
import { inspectPlugins } from './plugins'
import { buildSystemPrompt } from './service'
import { inspectSkills } from './skills'
import { describeTools } from './tools'

function defaultAgent(skills: ManagedSkill[], toolIds: string[], instructions: string): ManagedAgent {
  return {
    id: 'default', name: GENERAL_ASSISTANT_NAME, enabled: true,
    description: '查找和整理记录，按要求操作文件、目录与属性，并按需加载技能。',
    instructions,
    skillIds: skills.filter(skill => skill.enabled && !missingSkillTools(skill, toolIds).length).map(skill => skill.id),
    toolIds,
  }
}

export async function capabilityCatalog(vault: VaultService, index: IndexService, config?: AssistantConfiguration): Promise<CapabilityCatalog> {
  const saved = config ?? await vault.getAssistantConfiguration()
  const tools = describeTools(index).map(tool => ({ ...tool, enabled: !saved.disabledToolIds.includes(tool.id) }))
  const toolIds = tools.filter(tool => !tool.loader && tool.enabled).map(tool => tool.id)
  const inspected = await inspectSkills(vault.skillFiles)
  const standaloneSkills = inspected.skills.map(skill => ({ ...skill, enabled: !saved.disabledSkillIds.includes(skill.id) }))
  const packages = await inspectPlugins(vault, saved, toolIds, standaloneSkills)
  const skills: ManagedSkill[] = [...standaloneSkills, ...packages.skills]
  const agents = [defaultAgent(skills, toolIds, saved.defaultInstructions), ...packages.agents, ...saved.agents]
  const issues = [...inspected.issues, ...packages.issues]
  const taskBindings = AI_TASK_KINDS.map(task => {
    const skillId = saved.taskSkills[task], skill = skills.find(skill => skill.id === skillId)
    const issues = !skill ? ['技能不存在：' + skillId] : !skill.enabled ? ['技能已停用：' + skillId] : missingSkillTools(skill, toolIds).map(tool => '缺少工具：' + tool)
    if (skill?.enabled) issues.push(...taskToolProblems(skill))
    return { task, skillId, issues }
  })
  return { prompt: buildSystemPrompt(skills.filter(skill => agents[0]!.skillIds.includes(skill.id))), skills, tools, issues, agents, plugins: packages.plugins, taskBindings }
}

/** 通用助手只调整业务说明，绑定自动发现；自建智能体保存完整配置。 */
export async function changeAgent(vault: VaultService, index: IndexService, change: AgentChange): Promise<CapabilityCatalog> {
  const saved = await vault.getAssistantConfiguration()
  if (change.action === 'configure-default') {
    await vault.saveAssistantConfiguration({ ...saved, defaultInstructions: change.instructions })
    return capabilityCatalog(vault, index)
  }
  const catalog = await capabilityCatalog(vault, index, saved)
  const id = change.action === 'save' ? change.agent.id : change.id
  if (id === 'default' || id.includes(':')) throw new JotError('INVALID_INPUT', '请复制为自建智能体后调整')
  const agents = saved.agents.filter(agent => agent.id !== id)
  if (change.action === 'save') {
    const { agent } = change
    if (catalog.agents.some(other => other.id !== id && other.name.toLowerCase() === agent.name.toLowerCase())) {
      throw new JotError('CONFLICT', '智能体名称已存在')
    }
    validateAgentBindings(agent, catalog)
    const at = saved.agents.findIndex(entry => entry.id === id)
    agents.splice(at < 0 ? agents.length : at, 0, agent)
  }
  const updated = { ...saved, agents }
  await vault.saveAssistantConfiguration(updated)
  return capabilityCatalog(vault, index, updated)
}

export function validateAgentBindings(agent: AgentConfiguration, catalog: CapabilityCatalog): void {
  const tools = catalog.tools.filter(tool => !tool.loader).map(tool => tool.id)
  if (agent.toolIds.some(tool => !tools.includes(tool))) throw new JotError('INVALID_INPUT', '智能体只能使用应用提供的工具')
  if (agent.enabled && agent.toolIds.some(id => !catalog.tools.some(tool => tool.id === id && tool.enabled))) throw new JotError('INVALID_INPUT', '绑定的工具已停用，请调整或启用工具')
  if (agent.enabled) for (const skillId of agent.skillIds) {
    const skill = catalog.skills.find(skill => skill.id === skillId)
    if (!skill?.enabled) throw new JotError('INVALID_INPUT', '绑定技能已停用或删除：' + skillId)
    const missing = missingSkillTools(skill, agent.toolIds)
    if (missing.length) throw new JotError('INVALID_INPUT', '智能体缺少技能所需工具：' + missing.join('、'))
  }
}
