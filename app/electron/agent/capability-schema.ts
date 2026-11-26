import { z } from 'zod'
import { isSkillName, MAX_SKILL_TEXT_BYTES } from '@shared/capabilities'

export const skillName = z.string().refine(isSkillName, '技能标识须使用小写英文、数字和单个短横线，最多 64 个字符')
const agentId = z.string().min(1).max(160)
export const skillId = z.string().refine(value => {
  const parts = value.split(':')
  return parts.length <= 2 && parts.every(isSkillName)
}, '技能标识或插件技能引用无效')

const toolIds = z.array(z.string().trim().min(1)).refine(ids => new Set(ids).size === ids.length, '工具标识重复')
const instructions = z.string().trim().min(1).max(MAX_SKILL_TEXT_BYTES)

export const agentConfiguration = z.object({
  id: agentId,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(2000),
  instructions,
  skillIds: z.array(skillId).max(100),
  toolIds,
  enabled: z.boolean(),
}).strict()

export const assistantConfiguration = z.object({
  disabledAgentIds: z.array(agentId),
  disabledToolIds: toolIds,
  defaultInstructions: instructions,
  taskSkills: z.object({
    daily: skillId, 'summarize-file': skillId, classify: skillId, 'find-synonyms': skillId,
  }).strict(),
  agents: z.array(agentConfiguration),
  disabledSkillIds: z.array(skillId),
  enabledVaultPluginIds: z.array(skillName),
  disabledBundledPluginIds: z.array(skillName),
}).strict()

export const agentChange = z.discriminatedUnion('action', [
  z.object({ action: z.literal('configure-default'), instructions }).strict(),
  z.object({ action: z.literal('save'), agent: agentConfiguration }).strict(),
  z.object({ action: z.literal('remove'), id: agentId }).strict(),
])

const pluginAgent = agentConfiguration.omit({ instructions: true, enabled: true })
  .extend({ id: skillName, skillIds: z.array(skillId).max(100).default([]), toolIds: toolIds.default([]) })
const unique = (ids: string[]) => new Set(ids).size === ids.length

export const pluginManifest = z.object({
  schemaVersion: z.literal(1),
  id: skillName,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(2000),
  agents: z.array(pluginAgent).default([]),
  skills: z.array(skillName).default([]),
  requiredTools: z.array(z.string().trim().min(1)).default([]),
}).strict().refine(manifest => manifest.agents.length + manifest.skills.length > 0, '插件至少声明一个智能体或技能')
  .refine(manifest => unique(manifest.skills) && unique(manifest.agents.map(agent => agent.id)), '插件内标识重复')

export const skillContent = z.object({
  name: skillName,
  title: z.string().trim().min(1).max(MAX_SKILL_TEXT_BYTES),
  description: z.string().trim().min(1).max(MAX_SKILL_TEXT_BYTES),
  body: z.string().max(MAX_SKILL_TEXT_BYTES).refine(body => !!body.trim(), '请输入技能说明'),
  requiredTools: z.array(z.string()).nullable(),
}).strict()

export const skillChange = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'), content: skillContent, enabled: z.boolean(),
    id: skillId.optional(), copyFrom: skillId.optional(), replaceReferences: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal('enable'), id: skillId, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('remove'), id: skillId }).strict(),
])

export const capabilityOwner = z.enum(['skill', 'plugin'])
export const resourcePatch = z.object({ path: z.string().min(1).max(1000), content: z.string().max(MAX_SKILL_TEXT_BYTES).nullable() }).strict()
export const pluginChange = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), id: skillName.optional(), manifest: pluginManifest, files: z.array(resourcePatch).max(1000), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('copy'), id: skillName, targetId: skillName, name: z.string().trim().min(1).max(60), replaceReferences: z.boolean() }).strict(),
  z.object({ action: z.literal('remove'), id: skillName }).strict(),
])
export const taskBindings = z.object({ daily: skillId, 'summarize-file': skillId, classify: skillId, 'find-synonyms': skillId }).strict()
