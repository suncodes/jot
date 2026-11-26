import fs from 'node:fs'
import type { AssistantContext, MaterialReference, TurnContext } from '@shared/assistant'
import { missingSkillTools, type ManagedSkill } from '@shared/capabilities'
import { JotError } from '@shared/result'
import type { IndexService } from '../index/index'
import type { VaultService } from '../vault/vault'
import { capabilityCatalog } from './catalog'
import { resolveFile } from './file-paths'
import { pluginFiles } from './plugins'
import type { PackageSnapshot } from '../vault/package-files'

/** 只准备当前配置和路径，正文由 read 工具在使用时从磁盘取得。 */
export async function prepareTurn(vault: VaultService, index: IndexService, context?: AssistantContext): Promise<{ context: TurnContext; skills: ManagedSkill[]; resources: Map<string, PackageSnapshot> }> {
  const catalog = await capabilityCatalog(vault, index)
  const request = context ?? { agentId: 'default', references: [], strict: false, skillIds: [] }
  const agent = catalog.agents.find(a => a.id === request.agentId)
  if (!agent?.enabled) throw new JotError('INVALID_INPUT', '智能体已停用或删除，请重新选择')
  const skills = catalog.skills.filter(s => agent.skillIds.includes(s.id))
  for (const id of agent.skillIds) {
    const skill = skills.find(s => s.id === id)
    if (!skill?.enabled) throw new JotError('INVALID_INPUT', '绑定技能已停用或删除，请调整智能体')
    const missing = missingSkillTools(skill, agent.toolIds)
    if (missing.length) throw new JotError('INVALID_INPUT', '智能体缺少技能所需工具：' + missing.join('、'))
  }
  if (agent.toolIds.some(id => !catalog.tools.some(t => t.id === id && !t.loader && t.enabled))) throw new JotError('INVALID_INPUT', '智能体包含不可用工具')
  if (request.skillIds.some(id => !skills.some(s => s.id === id && s.enabled))) throw new JotError('INVALID_INPUT', '所选技能不属于当前智能体')
  if (request.strict && !request.references.length) throw new JotError('INVALID_INPUT', '限定材料为空，请添加材料或明确解除限定')
  const references: MaterialReference[] = []
  for (const input of request.references) {
    const location = resolveFile(vault, input.value)
    const rel = location.path
    if (references.some(r => r.kind === input.kind && r.value === rel)) continue
    const stat = await fs.promises.stat(location.absolute).catch(() => null)
    if (!stat || (input.kind === 'folder' ? !stat.isDirectory() : !stat.isFile())) throw new JotError('NOT_FOUND', '引用路径不存在：' + rel + '，请调整引用后重新发送')
    references.push({ kind: input.kind, value: rel, title: input.title })
  }
  const activeSkills = skills.filter(skill => !skill.manualOnly || request.skillIds.includes(skill.id))
  const resources = new Map<string, PackageSnapshot>()
  for (const skill of activeSkills) {
    const plugin = skill.pluginId ? catalog.plugins.find(plugin => plugin.id === skill.pluginId) : undefined
    resources.set(skill.id, plugin ? await pluginFiles(vault, plugin.source).snapshot(plugin.id, skill.name) : await vault.skillFiles.snapshot(skill.id))
  }
  return {
    resources,
    context: {
      agentId: agent.id, agent, skillIds: request.skillIds, strict: request.strict, references, reasoningEffort: request.reasoningEffort, reasoningModel: request.reasoningModel,
      skills: activeSkills.map(({ id, name, title }) => ({ id, name, title })),
    },
    skills: activeSkills,
  }
}
export function describeMaterials(context: TurnContext): string {
  const refs = context.references.map(r => '- ' + (r.kind === 'folder' ? '目录' : '文件') + '：' + r.value).join('\n')
  return '\n本轮智能体：' + context.agent.name + '\n材料模式：' + (context.strict
    ? '只根据以下材料回答。以前的回答不作为当前文件依据，读取与查询不能扩大范围。'
    : '以下材料优先参考，默认补充检索本库；用户明确指定库外路径时也可使用并说明出处。')
    + '\n' + (refs || '没有指定材料，按问题检索本库。')
    + '\n多轮沿用已明确的库内或库外路径；每轮用工具读取当前磁盘内容，旧回答和旧工具结果不代表当前文件。\n'
}
