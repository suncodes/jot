import type { z } from 'zod'
import { pluginCapabilityId, type AssistantConfiguration, type CapabilitySkill, type ManagedAgent, type ManagedPlugin, type ManagedSkill } from '@shared/capabilities'
import { JotError } from '@shared/result'
import { DIRS } from '../vault/paths'
import { PackageFiles, packageText, type PackageEntry } from '../vault/package-files'
import type { VaultService } from '../vault/vault'
import { pluginManifest } from './capability-schema'
import { readSkill } from './skills'

export type PluginManifest = z.infer<typeof pluginManifest>
type Source = ManagedPlugin['source']
interface PluginPackage {
  id: string
  source: Source
  manifest: PluginManifest
  agents: ManagedAgent[]
  skills: CapabilitySkill[]
  issues: string[]
}

export function parsePlugin(text: string): PluginManifest {
  let raw: unknown
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new JotError('INVALID_INPUT', 'plugin.json 必须是有效的 JSON') }
  const parsed = pluginManifest.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]!
    throw new JotError('INVALID_INPUT', 'plugin.json ' + (detail.path.join('.') || '清单') + '：' + detail.message)
  }
  return parsed.data
}

const skillDirectory = (name: string): string => 'skills/' + name
const promptPath = (id: string): string => 'agents/' + id + '/PROMPT.md'
const errorMessage = (error: unknown): string => error instanceof JotError ? error.message : (error as NodeJS.ErrnoException).code === 'ENOENT' ? '缺少声明的文件' : '无法读取普通文件，请检查路径及访问权限'

export function pluginFiles(vault: VaultService, source: Source): PackageFiles {
  return source === 'bundled' ? new PackageFiles(() => vault.bundledPluginRoot, 'plugin.json') : vault.pluginFiles
}

export function pluginSkillPackage(vault: VaultService, source: Source, pluginId: string, name: string): Promise<PackageEntry[]> {
  return pluginFiles(vault, source).skillPackage(pluginId, name)
}

async function loadPlugin(
  manifest: PluginManifest, source: Source, location: string,
  read: (relative: string) => Promise<string>, hasScripts: (name: string) => Promise<boolean>,
): Promise<PluginPackage> {
  const pkg: PluginPackage = { id: manifest.id, source, manifest, agents: [], skills: [], issues: [] }
  for (const agent of manifest.agents) {
    try {
      const instructions = (await read(promptPath(agent.id))).trim()
      if (!instructions) throw new JotError('INVALID_INPUT', '智能体说明为空')
      pkg.agents.push({ ...agent, id: pluginCapabilityId(manifest.id, agent.id), instructions, pluginId: manifest.id, enabled: true })
    } catch (error) { pkg.issues.push(promptPath(agent.id) + '：' + errorMessage(error)) }
  }
  for (const name of manifest.skills) {
    const relative = skillDirectory(name)
    try {
      const skill = await readSkill(name, file => read(relative + '/' + file), () => hasScripts(name))
      pkg.skills.push({ ...skill, id: pluginCapabilityId(manifest.id, name), pluginId: manifest.id, path: location + '/' + relative + '/SKILL.md' })
    } catch (error) { pkg.issues.push(relative + '/SKILL.md：' + errorMessage(error)) }
  }
  return pkg
}

async function inspectRoot(files: PackageFiles, source: Source, rootLabel: string, issues: string[]): Promise<PluginPackage[]> {
  let names: string[]
  try { names = await files.directories() }
  catch (error) {
    issues.push(rootLabel + '：' + errorMessage(error))
    return []
  }
  const packages: PluginPackage[] = []
  for (const id of names) {
    const location = rootLabel + '/' + id
    try {
      const manifest = parsePlugin(await files.read(id))
      if (manifest.id !== id) throw new JotError('INVALID_INPUT', '插件目录名须与清单的 id 一致')
      packages.push(await loadPlugin(manifest, source, location,
        relative => files.read(id, relative), name => files.hasScripts(id, skillDirectory(name) + '/scripts')))
    } catch (error) { issues.push(location + '/plugin.json：' + errorMessage(error)) }
  }
  return packages
}

export async function previewPlugin(entries: PackageEntry[]): Promise<PluginPackage> {
  const text = packageText(entries, 'plugin.json')
  if (text === null) throw new JotError('INVALID_INPUT', '所选目录缺少 plugin.json')
  const manifest = parsePlugin(text)
  const read = async (relative: string) => {
    const text = packageText(entries, relative)
    if (text === null) throw Object.assign(new Error('缺少文件 ' + relative), { code: 'ENOENT' })
    return text
  }
  return loadPlugin(manifest, 'vault', DIRS.plugins + '/' + manifest.id, read,
    async name => entries.some(entry => entry.path === skillDirectory(name) + '/scripts' && entry.data === null))
}

export function pluginDependencies(pkg: PluginPackage, toolIds: string[], allSkills: Pick<ManagedSkill, 'id' | 'enabled' | 'requiredTools'>[], disabledSkillIds: readonly string[] = []): string[] {
  const issues = [...pkg.issues]
  const required = new Set([...pkg.manifest.requiredTools, ...pkg.agents.flatMap(agent => agent.toolIds), ...pkg.skills.flatMap(skill => skill.requiredTools ?? [])])
  const missing = [...required].filter(tool => !toolIds.includes(tool))
  if (missing.length) issues.push('缺少 Jot 工具：' + missing.join('、'))
  for (const agent of pkg.agents) {
    const absent = agent.skillIds.filter(id => !allSkills.some(skill => skill.id === id))
    if (absent.length) issues.push(agent.name + ' 缺少技能：' + absent.join('、'))
    const disabled = allSkills.filter(skill => agent.skillIds.includes(skill.id) && !skill.enabled
      && (!pkg.skills.some(own => own.id === skill.id) || disabledSkillIds.includes(skill.id)))
    if (disabled.length) issues.push(agent.name + ' 依赖的技能已停用：' + disabled.map(skill => skill.id).join('、'))
    const required = allSkills.filter(skill => agent.skillIds.includes(skill.id)).flatMap(skill => skill.requiredTools ?? [])
    const unbound = [...new Set(required)].filter(tool => !agent.toolIds.includes(tool))
    if (unbound.length) issues.push(agent.name + ' 未绑定技能所需工具：' + unbound.join('、'))
  }
  return issues
}

export async function inspectPlugins(vault: VaultService, config: AssistantConfiguration, toolIds: string[], standaloneSkills: ManagedSkill[]): Promise<{
  plugins: ManagedPlugin[]; agents: ManagedAgent[]; skills: ManagedSkill[]; issues: string[]
}> {
  const issues: string[] = []
  const bundled = await inspectRoot(pluginFiles(vault, 'bundled'), 'bundled', 'resources/plugins', issues)
  const external = await inspectRoot(vault.pluginFiles, 'vault', DIRS.plugins, issues)
  const available = [...bundled]
  for (const pkg of external) {
    if (bundled.some(other => other.id === pkg.id)) issues.push(DIRS.plugins + '/' + pkg.id + '：与预装插件标识重复')
    else available.push(pkg)
  }
  const enabledPackages = new Set(available.filter(pkg => pkg.source === 'bundled'
    ? !config.disabledBundledPluginIds.includes(pkg.id) : config.enabledVaultPluginIds.includes(pkg.id)).map(pkg => pkg.id))
  const allSkills = [...standaloneSkills, ...available.flatMap(pkg => pkg.skills.map(skill => ({
    ...skill, enabled: enabledPackages.has(pkg.id) && !config.disabledSkillIds.includes(skill.id) && pkg.manifest.requiredTools.every(tool => toolIds.includes(tool)),
  })))]
  const agents: ManagedAgent[] = []
  const skills: ManagedSkill[] = []
  const plugins = available.map(pkg => {
    const manifest = pkg.manifest
    const enabled = enabledPackages.has(pkg.id)
    const requiredTools = [...new Set([...manifest.requiredTools, ...pkg.agents.flatMap(agent => agent.toolIds), ...pkg.skills.flatMap(skill => skill.requiredTools ?? [])])]
    const pluginIssues = pluginDependencies(pkg, toolIds, allSkills, config.disabledSkillIds)
    const active = enabled && !manifest.requiredTools.some(tool => !toolIds.includes(tool))
    agents.push(...pkg.agents.map(agent => ({ ...agent, enabled: active && !config.disabledAgentIds.includes(agent.id) })))
    skills.push(...pkg.skills.map(skill => ({ ...skill, enabled: active && !config.disabledSkillIds.includes(skill.id) })))
    return {
      id: pkg.id, source: pkg.source, enabled, issues: pluginIssues, name: manifest.name, description: manifest.description,
      agentIds: manifest.agents.map(agent => pluginCapabilityId(pkg.id, agent.id)),
      skillIds: manifest.skills.map(name => pluginCapabilityId(pkg.id, name)), requiredTools,
    }
  })
  return { agents, skills, plugins, issues }
}
