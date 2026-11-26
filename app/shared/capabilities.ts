// 智能体目录及按库保存的配置，执行工具由应用提供。
import { DEFAULT_TASK_SKILLS, type TaskSkillBindings } from './ai-tasks'

export const GENERAL_ASSISTANT_NAME = '通用助手'
export const GENERAL_ASSISTANT_INSTRUCTIONS = '先查找当前依据再回答，需要时加载技能。普通问答只回答；用户明确要求记录、创建、修改或整理时，使用实际可用工具连续完成，报告结果和失败原因。删除和整篇覆盖通过界面集中确认。'
export interface SkillContent {
  name: string
  title: string
  description: string
  body: string
  requiredTools: string[] | null
}

export interface CapabilitySkill extends SkillContent {
  id: string
  path: string
  pluginId?: string
  warnings?: string[]
  manualOnly?: boolean
}

export const MAX_SKILL_TEXT_BYTES = 256 * 1024

export function isSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)
}

/** 包内能力用插件标识限定，避免不同包或独立技能同名。 */
export const pluginCapabilityId = (pluginId: string, name: string): string => pluginId + ':' + name

export type SkillChange =
  | { action: 'save'; content: SkillContent; enabled: boolean; id?: string; copyFrom?: string; replaceReferences?: boolean }
  | { action: 'enable'; id: string; enabled: boolean }
  | { action: 'remove'; id: string }

export interface SkillImportPreview {
  token: string
  suggestedName: string
  conflict: boolean
  title: string
  name: string
  description: string
  files: string[]
  requiredTools: string[] | null
  warnings: string[]
  updating?: string
  removedFiles?: string[]
}

export interface PluginImportPreview {
  token: string
  id: string
  name: string
  description: string
  files: string[]
  issues: string[]
  updating?: string
  removedFiles?: string[]
}

export interface CapabilityTool {
  id: string
  title: string
  description: string
  parameters: string
  loader: boolean
  access: 'read' | 'write' | 'loader'
  enabled: boolean
  source: 'builtin'
}

export interface CapabilityCatalog {
  prompt: string
  skills: ManagedSkill[]
  tools: CapabilityTool[]
  issues: string[]
  agents: ManagedAgent[]
  plugins: ManagedPlugin[]
  taskBindings: TaskSkillBinding[]
}
export interface AgentConfiguration {
  id: string
  name: string
  description: string
  instructions: string
  skillIds: string[]
  toolIds: string[]
  enabled: boolean
}
export type AgentChange =
  | { action: 'configure-default'; instructions: string }
  | { action: 'save'; agent: AgentConfiguration }
  | { action: 'remove'; id: string }

export interface ManagedAgent extends AgentConfiguration {
  pluginId?: string
}
export function missingSkillTools(skill: SkillContent, toolIds: string[]): string[] {
  return skill.requiredTools?.filter(id => !toolIds.includes(id)) ?? []
}

export interface ManagedSkill extends CapabilitySkill {
  enabled: boolean
}
export interface ManagedPlugin {
  id: string
  name: string
  description: string
  source: 'bundled' | 'vault'
  enabled: boolean
  issues: string[]
  agentIds: string[]
  skillIds: string[]
  requiredTools: string[]
}

export interface AssistantConfiguration {
  disabledAgentIds: string[]
  disabledToolIds: string[]
  defaultInstructions: string
  taskSkills: TaskSkillBindings
  enabledVaultPluginIds: string[]
  disabledBundledPluginIds: string[]
  disabledSkillIds: string[]
  agents: AgentConfiguration[]
}

export function createAssistantConfiguration(): AssistantConfiguration {
  return {
    defaultInstructions: GENERAL_ASSISTANT_INSTRUCTIONS,
    taskSkills: { ...DEFAULT_TASK_SKILLS },
    disabledAgentIds: [], disabledToolIds: [], agents: [], disabledSkillIds: [], enabledVaultPluginIds: [], disabledBundledPluginIds: [],
  }
}

export interface TaskSkillBinding {
  task: import('./ai-tasks').AiTaskKind
  skillId: string
  issues: string[]
}
export type CapabilityOwner = 'skill' | 'plugin'
export interface CapabilityResource { path: string; bytes: number; text: boolean }
export interface CapabilityFileInput { path: string; content: string | null }
export interface PluginDefinition {
  schemaVersion: 1
  id: string
  name: string
  description: string
  agents: Omit<AgentConfiguration, 'instructions' | 'enabled'>[]
  skills: string[]
  requiredTools: string[]
}
export type PluginChange =
  | { action: 'save'; id?: string; manifest: PluginDefinition; files: CapabilityFileInput[]; enabled: boolean }
  | { action: 'copy'; id: string; targetId: string; name: string; replaceReferences: boolean }
  | { action: 'remove'; id: string }


/** 后台取材由程序提供；技能只能继续加载包内资源。 */
export function taskToolProblems(skill: Pick<ManagedSkill, 'requiredTools'>): string[] {
  return (skill.requiredTools ?? []).filter(tool => tool !== 'use_skill').map(tool => '后台任务不开放工具：' + tool + '；请使用处理所给材料的技能')
}
