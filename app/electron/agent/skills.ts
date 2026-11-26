import yaml from 'js-yaml'
import { isSkillName, type CapabilitySkill, type SkillContent } from '@shared/capabilities'
import { JotError } from '@shared/result'
import { parseDoc, stringifyDoc } from '../vault/frontmatter'
import { DIRS } from '../vault/paths'
import type { PackageFiles } from '../vault/package-files'

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
  return typeof value === 'string' ? value.split(/[,\s]+/).filter(Boolean) : []
}

function declaredTools(data: Record<string, unknown>, key: string): string[] | null {
  return Object.hasOwn(data, key) ? list(data[key]) : null
}

export function parseSkill(text: string): SkillContent & Pick<CapabilitySkill, 'warnings' | 'manualOnly'> {
  const { data, body, invalid, hasFrontmatter } = parseDoc(text)
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : /^#[ \t]+(.+)$/m.exec(body)?.[1]?.trim() ?? name
  if (invalid || !hasFrontmatter) throw new JotError('INVALID_INPUT', 'SKILL.md 文件头格式错误，需要 YAML 文件头')
  if (!name || !description || !body.trim()) throw new JotError('INVALID_INPUT', 'SKILL.md 缺少标识、用途或正文')
  if (!isSkillName(name)) throw new JotError('INVALID_INPUT', 'SKILL.md 的 name 必须使用小写英文、数字和短横线')
  const warnings: string[] = []
  if (typeof data.compatibility === 'string' && data.compatibility.trim()) warnings.push('环境要求：' + data.compatibility.trim())
  const externalTools = declaredTools(data, 'allowed-tools')
  if (externalTools?.length) warnings.push('来源平台声明的工具：' + externalTools.join('、') + '。Jot 按当前智能体的工具绑定执行。')
  if (data.context === 'fork') warnings.push('当前 Jot 不支持 Claude 子智能体运行模式（context: fork）。')
  if (data.hooks != null) warnings.push('当前 Jot 不执行技能中的 hooks。')
  if (data.agent != null) warnings.push('来源平台的 agent 字段需要重新绑定 Jot 智能体。')
  return {
    name, title, description, body, requiredTools: declaredTools(data, 'required_tools'),
    ...(warnings.length ? { warnings } : {}),
    ...(data['disable-model-invocation'] === true ? { manualOnly: true } : {}),
  }
}

export function skillPackageInfo(skill: Pick<CapabilitySkill, 'warnings' | 'manualOnly'>, hasScripts: boolean, codexConfig: string | null): { warnings: string[]; manualOnly: boolean } {
  const warnings = [...(skill.warnings ?? [])]
  let manualOnly = skill.manualOnly ?? false
  if (hasScripts) warnings.push('目录包含 scripts。当前版本可以保存脚本文件，助手无法执行它们。')
  if (codexConfig) {
    try {
      const config = yaml.load(codexConfig, { schema: yaml.JSON_SCHEMA }) as {
        dependencies?: { tools?: { type?: string; value?: string }[] }
        policy?: { allow_implicit_invocation?: boolean }
      } | null
      if (config?.policy?.allow_implicit_invocation === false) manualOnly = true
      const tools = config?.dependencies?.tools
      if (Array.isArray(tools) && tools.length) {
        const names = tools.map(tool => typeof tool?.value === 'string' ? tool.value : typeof tool?.type === 'string' ? tool.type : '未命名工具')
        warnings.push('Codex 声明的外部工具：' + names.join('、') + '。请根据当前 Jot 工具调整做法。')
      }
    } catch {
      warnings.push('无法解析 Codex 的 agents/openai.yaml。')
    }
  }
  return { warnings, manualOnly }
}

export function skillMarkdown(content: SkillContent, previous?: string): string {
  const data = previous === undefined ? {} : parseDoc(previous).data
  return stringifyDoc({
    ...data,
    name: content.name,
    title: content.title,
    description: content.description,
    required_tools: content.requiredTools ?? undefined,
  }, content.body.endsWith('\n') ? content.body : content.body + '\n')
}

export function renameSkill(text: string, name: string): string {
  const { data, body } = parseDoc(text)
  return stringifyDoc({ ...data, name }, body)
}

export type SkillReader = (relative: string) => Promise<string>

export async function readSkill(id: string, reader: SkillReader, hasScripts: () => Promise<boolean>): Promise<SkillContent & Pick<CapabilitySkill, 'warnings' | 'manualOnly'>> {
  const skill = parseSkill(await reader('SKILL.md'))
  if (skill.name !== id) throw new JotError('INVALID_INPUT', '技能目录名须与 SKILL.md 的 name 一致')
  let config: string | null = null
  let warning: string | undefined
  try { config = await reader('agents/openai.yaml') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warning = '无法读取 Codex 的 agents/openai.yaml。'
  }
  const info = skillPackageInfo(skill, await hasScripts(), config)
  if (warning) info.warnings.push(warning)
  return { ...skill, ...info }
}

/** 单个损坏文件显示诊断，其余技能继续可用。 */
export async function inspectSkills(files: PackageFiles): Promise<{ skills: CapabilitySkill[]; issues: string[] }> {
  const issues: string[] = []
  const skills: CapabilitySkill[] = []
  for (const id of await files.directories()) {
    try {
      const content = await readSkill(id, relative => files.read(id, relative), () => files.hasScripts(id))
      skills.push({ ...content, id, path: DIRS.skills + '/' + id + '/SKILL.md' })
    } catch (error) {
      const issue = error instanceof JotError ? error.message : '无法读取，请检查文件和访问权限'
      issues.push(id + '/SKILL.md：' + issue)
    }
  }
  return { skills, issues }
}
