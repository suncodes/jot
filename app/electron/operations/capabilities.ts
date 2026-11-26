import type { CapabilityFileInput, CapabilityOwner, PluginChange, AgentChange, SkillChange, CapabilityCatalog } from '@shared/capabilities'
import { missingSkillTools } from '@shared/capabilities'
import type { TaskSkillBindings } from '@shared/ai-tasks'
import { JotError } from '@shared/result'
import type { Core } from '../core'
import { packageSegments, packageText, skillText, validatePackageEntries, type PackageEntry } from '../vault/package-files'
import { capabilityCatalog, changeAgent, validateAgentBindings } from '../agent/catalog'
import { changeSkill, SkillImporter } from '../agent/skill-management'
import { PluginImporter, setPluginEnabled } from '../agent/plugin-management'
import { parsePlugin, pluginFiles, previewPlugin } from '../agent/plugins'
import { parseSkill, skillMarkdown } from '../agent/skills'
import type { Platform } from '../ipc/handlers'

/** 能力文件只由专用服务维护；UI与助手共用校验、依赖和变更通知。 */
export class CapabilityManager {
  readonly skillImporter = new SkillImporter()
  readonly pluginImporter = new PluginImporter()
  private platform?: Platform
  private picking = false
  private openingVault = () => false
  constructor(private readonly core: Core, private readonly changed: () => void) {}
  setPlatform(platform: Platform, openingVault = () => false): void { this.platform = platform; this.openingVault = openingVault }
  clear(): void { this.skillImporter.clear(); this.pluginImporter.clear() }
  catalog(): Promise<CapabilityCatalog> { return capabilityCatalog(this.core.vault, this.core.index) }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const database = this.core.state.raw
    try { return await this.core.mutate(() => {
      if (this.openingVault() || !this.core.state.isOpen || this.core.state.raw !== database) throw new JotError('CONFLICT', '库已切换，请在当前库重试')
      return operation()
    }) }
    finally { this.changed() }
  }
  private get vault() { return this.core.vault }
  async agent(change: AgentChange) {
    return this.mutate(async () => {
      const id = change.action === 'save' ? change.agent.id : change.action === 'remove' ? change.id : 'default'
      const catalog = await this.catalog(), existing = catalog.agents.find(agent => agent.id === id)
      if (existing?.pluginId) {
        const plugin = catalog.plugins.find(plugin => plugin.id === existing.pluginId)!
        if (plugin.source !== 'vault') throw new JotError('WRITE_DENIED', '预装能力请复制到本库后修改')
        if (change.action !== 'configure-default') {
          const manifest = parsePlugin(await this.vault.pluginFiles.read(plugin.id)), shortId = id.split(':')[1]!
          if (change.action === 'remove') {
            manifest.agents = manifest.agents.filter(agent => agent.id !== shortId)
            const entries = (await this.vault.pluginFiles.package(plugin.id)).filter(entry => !entry.path.startsWith('agents/' + shortId + '/'))
            await this.storePlugin(plugin.id, manifest, entries)
            const config = await this.vault.getAssistantConfiguration()
            config.disabledAgentIds = config.disabledAgentIds.filter(value => value !== id)
            await this.vault.saveAssistantConfiguration(config)
          } else {
            validateAgentBindings(change.agent, catalog)
            const { instructions, enabled, ...agent } = change.agent
            manifest.agents = manifest.agents.map(entry => entry.id === shortId ? { ...agent, id: shortId } : entry)
            const entries = patchEntries(await this.vault.pluginFiles.package(plugin.id), [{ path: 'agents/' + shortId + '/PROMPT.md', content: instructions }])
            await this.storePlugin(plugin.id, manifest, entries)
            const config = await this.vault.getAssistantConfiguration()
            config.disabledAgentIds = enabled ? config.disabledAgentIds.filter(value => value !== id) : [...new Set([...config.disabledAgentIds, id])]
            await this.vault.saveAssistantConfiguration(config)
          }
          return this.catalog()
        }
      }
      return changeAgent(this.vault, this.core.index, change)
    })
  }
  async enableAgent(id: string, enabled: boolean) {
    return this.mutate(async () => {
      const catalog = await this.catalog(), agent = catalog.agents.find(agent => agent.id === id)
      if (!agent) throw new JotError('NOT_FOUND', '智能体不存在')
      if (id === 'default') throw new JotError('WRITE_DENIED', '通用助手不能停用')
      if (!agent.pluginId) {
        const { pluginId: _pluginId, ...config } = agent
        return changeAgent(this.vault, this.core.index, { action: 'save', agent: { ...config, enabled } })
      }
      const config = await this.vault.getAssistantConfiguration()
      config.disabledAgentIds = enabled ? config.disabledAgentIds.filter(value => value !== id) : [...new Set([...config.disabledAgentIds, id])]
      await this.vault.saveAssistantConfiguration(config)
      return this.catalog()
    })
  }
  async skill(change: SkillChange) {
    return this.mutate(async () => {
      const catalog = await this.catalog()
      const id = change.id
      const existing = catalog.skills.find(skill => skill.id === id)
      if (existing?.pluginId && change.action !== 'enable') {
        const plugin = catalog.plugins.find(plugin => plugin.id === existing.pluginId)!
        if (plugin.source !== 'vault') throw new JotError('WRITE_DENIED', '预装技能请复制为本库技能后修改')
        const manifest = parsePlugin(await this.vault.pluginFiles.read(plugin.id))
        let entries = await this.vault.pluginFiles.package(plugin.id)
        const prefix = 'skills/' + existing.name + '/'
        if (change.action === 'remove') {
          manifest.skills = manifest.skills.filter(name => name !== existing.name)
          entries = entries.filter(entry => entry.path !== prefix.slice(0, -1) && !entry.path.startsWith(prefix))
        } else {
          if (change.content.name !== existing.name || change.copyFrom) throw new JotError('INVALID_INPUT', '编辑不能改变技能标识')
          entries = patchEntries(entries, [{ path: prefix + 'SKILL.md', content: skillMarkdown(change.content, packageText(entries, prefix + 'SKILL.md') ?? undefined) }])
        }
        await this.storePlugin(plugin.id, manifest, entries)
        if (change.action === 'remove') {
          const config = await this.vault.getAssistantConfiguration()
          config.disabledSkillIds = config.disabledSkillIds.filter(value => value !== id)
          await this.vault.saveAssistantConfiguration(config)
        }
        if (change.action === 'save') {
          const config = await this.vault.getAssistantConfiguration()
          config.disabledSkillIds = change.enabled ? config.disabledSkillIds.filter(value => value !== id) : [...new Set([...config.disabledSkillIds, id!])]
          await this.vault.saveAssistantConfiguration(config)
        }
      } else await changeSkill(this.vault, this.core.index, change)
      if (change.action === 'save' && change.copyFrom && change.replaceReferences) {
        await this.replaceReferences({ [change.copyFrom]: change.content.name })
        await changeSkill(this.vault, this.core.index, { action: 'enable', id: change.copyFrom, enabled: false })
      }
      return this.catalog()
    })
  }
  async plugin(change: PluginChange) {
    return this.mutate(async () => {
      const catalog = await this.catalog()
      if (change.action === 'save') {
        const id = change.id ?? change.manifest.id
        if (id !== change.manifest.id) throw new JotError('INVALID_INPUT', '编辑不能改变插件标识')
        const existing = catalog.plugins.find(plugin => plugin.id === id)
        if (!change.id && (existing || (await this.vault.pluginFiles.directoryNames()).includes(id))) throw new JotError('CONFLICT', '插件标识已存在')
        if (change.id && existing?.source !== 'vault') throw new JotError('WRITE_DENIED', '只能编辑库内插件，预装插件请复制')
        const entries = patchEntries(change.id ? await this.vault.pluginFiles.package(id) : [], change.files)
        await this.storePlugin(change.id, change.manifest, entries)
        await setPluginEnabled(this.vault, this.core.index, id, change.enabled)
      } else if (change.action === 'copy') {
        const plugin = catalog.plugins.find(plugin => plugin.id === change.id)
        if (!plugin) throw new JotError('NOT_FOUND', '插件不存在')
        if (catalog.plugins.some(plugin => plugin.id === change.targetId)) throw new JotError('CONFLICT', '插件标识已存在')
        const entries = await pluginFiles(this.vault, plugin.source).package(plugin.id)
        const manifest = parsePlugin(packageText(entries, 'plugin.json')!)
        const mapping = Object.fromEntries([...manifest.skills, ...manifest.agents.map(agent => agent.id)].map(name => [plugin.id + ':' + name, change.targetId + ':' + name]))
        manifest.id = change.targetId; manifest.name = change.name
        manifest.agents = manifest.agents.map(agent => ({ ...agent, skillIds: agent.skillIds.map(id => mapping[id] ?? id) }))
        await this.storePlugin(undefined, manifest, entries)
        await setPluginEnabled(this.vault, this.core.index, manifest.id, plugin.enabled)
        if (change.replaceReferences) {
          await this.replaceReferences(mapping)
          await setPluginEnabled(this.vault, this.core.index, plugin.id, false)
        }
      } else {
        const plugin = catalog.plugins.find(plugin => plugin.id === change.id)
        if (!plugin || plugin.source !== 'vault') throw new JotError('WRITE_DENIED', '只能卸载库内插件；预装插件可停用')
        await this.vault.pluginFiles.remove(plugin.id)
        const config = await this.vault.getAssistantConfiguration()
        config.enabledVaultPluginIds = config.enabledVaultPluginIds.filter(id => id !== plugin.id)
        config.disabledSkillIds = config.disabledSkillIds.filter(id => !id.startsWith(plugin.id + ':'))
        config.disabledAgentIds = config.disabledAgentIds.filter(id => !id.startsWith(plugin.id + ':'))
        await this.vault.saveAssistantConfiguration(config)
      }
      return this.catalog()
    })
  }
  private async storePlugin(id: string | undefined, manifest: unknown, entries: PackageEntry[]) {
    const text = JSON.stringify(manifest, null, 2), parsed = parsePlugin(text)
    const updated = patchEntries(entries, [{ path: 'plugin.json', content: text }])
    validatePackageEntries(updated, 'plugin.json')
    const preview = await previewPlugin(updated)
    if (preview.issues.length) throw new JotError('INVALID_INPUT', preview.issues.join('；'))
    if (id) await this.vault.pluginFiles.replace(id, updated)
    else await this.vault.pluginFiles.install(parsed.id, updated)
  }
  async resources(owner: CapabilityOwner, id: string) {
    const located = await this.locate(owner, id)
    return located.entries.filter(entry => entry.data !== null && entry.path.startsWith(located.prefix)).map(entry => {
      let text = true
      try { skillText(entry.data!) } catch { text = false }
      return { path: entry.path.slice(located.prefix.length), bytes: entry.data!.byteLength, text }
    })
  }
  async readResource(owner: CapabilityOwner, id: string, relative: string): Promise<string> {
    const located = await this.locate(owner, id)
    packageSegments(relative)
    const result = packageText(located.entries, located.prefix + relative)
    if (result === null) throw new JotError('NOT_FOUND', '包内资源不存在')
    return result
  }
  async patchResources(owner: CapabilityOwner, id: string, files: CapabilityFileInput[]) {
    return this.mutate(async () => {
      const located = await this.locate(owner, id)
      if (located.bundled) throw new JotError('WRITE_DENIED', '预装资源请复制到本库后编辑')
      files.forEach(file => packageSegments(file.path))
      const entries = patchEntries(located.entries, files.map(file => ({ ...file, path: located.prefix + file.path })))
      if (owner === 'plugin' || located.pluginId) {
        const pluginId = located.pluginId ?? id, manifest = parsePlugin(packageText(entries, 'plugin.json')!)
        if (manifest.id !== pluginId) throw new JotError('INVALID_INPUT', '编辑不能改变插件标识')
        await this.storePlugin(pluginId, manifest, entries)
      } else {
        const skill = parseSkill(packageText(entries, 'SKILL.md') ?? '')
        if (skill.name !== id) throw new JotError('INVALID_INPUT', '编辑不能改变技能标识')
        await this.vault.skillFiles.replace(id, entries)
      }
      return this.catalog()
    })
  }
  private async locate(owner: CapabilityOwner, id: string) {
    const catalog = await this.catalog()
    if (owner === 'plugin') {
      const plugin = catalog.plugins.find(plugin => plugin.id === id)
      if (!plugin) throw new JotError('NOT_FOUND', '插件不存在')
      return { entries: await pluginFiles(this.vault, plugin.source).package(id), prefix: '', bundled: plugin.source === 'bundled' }
    }
    const skill = catalog.skills.find(skill => skill.id === id)
    if (!skill) throw new JotError('NOT_FOUND', '技能不存在')
    if (!skill.pluginId) return { entries: await this.vault.skillFiles.package(id), prefix: '', bundled: false }
    const plugin = catalog.plugins.find(plugin => plugin.id === skill.pluginId)!
    return { entries: await pluginFiles(this.vault, plugin.source).package(plugin.id), prefix: 'skills/' + skill.name + '/', pluginId: plugin.id, bundled: plugin.source === 'bundled' }
  }
  async tool(id: string, enabled: boolean) {
    return this.mutate(async () => {
      const tool = (await this.catalog()).tools.find(tool => tool.id === id)
      if (!tool || tool.loader) throw new JotError('INVALID_INPUT', '此工具不能单独停用')
      const config = await this.vault.getAssistantConfiguration()
      config.disabledToolIds = enabled ? config.disabledToolIds.filter(value => value !== id) : [...new Set([...config.disabledToolIds, id])]
      await this.vault.saveAssistantConfiguration(config)
      return this.catalog()
    })
  }
  async tasks(patch: Partial<TaskSkillBindings>) {
    return this.mutate(async () => {
      const catalog = await this.catalog(), tools = catalog.tools.filter(tool => tool.enabled && !tool.loader).map(tool => tool.id)
      for (const id of Object.values(patch)) {
        const skill = catalog.skills.find(skill => skill.id === id)
        if (!skill?.enabled) throw new JotError('INVALID_INPUT', '技能不存在或已停用：' + id)
        const missing = missingSkillTools(skill, tools)
        if (missing.length) throw new JotError('INVALID_INPUT', '技能缺少工具：' + missing.join('、'))
      }
      const config = await this.vault.getAssistantConfiguration()
      await this.vault.saveAssistantConfiguration({ ...config, taskSkills: { ...config.taskSkills, ...patch } })
      return this.catalog()
    })
  }
  private async replaceReferences(mapping: Record<string, string>) {
    const config = await this.vault.getAssistantConfiguration()
    config.agents = config.agents.map(agent => ({ ...agent, skillIds: agent.skillIds.map(id => mapping[id] ?? id) }))
    config.taskSkills = Object.fromEntries(Object.entries(config.taskSkills).map(([task, id]) => [task, mapping[id] ?? id])) as TaskSkillBindings
    await this.vault.saveAssistantConfiguration(config)
    const plugins = (await this.catalog()).plugins.filter(plugin => plugin.source === 'vault')
    for (const plugin of plugins) {
      const manifest = parsePlugin(await this.vault.pluginFiles.read(plugin.id))
      const next = manifest.agents.map(agent => ({ ...agent, skillIds: agent.skillIds.map(id => mapping[id] ?? id) }))
      if (JSON.stringify(next) !== JSON.stringify(manifest.agents)) await this.storePlugin(plugin.id, { ...manifest, agents: next }, await this.vault.pluginFiles.package(plugin.id))
    }
  }
  async impact(owner: CapabilityOwner | 'agent' | 'tool', id: string): Promise<string[]> {
    const catalog = await this.catalog(), ids = owner === 'plugin' ? catalog.plugins.find(plugin => plugin.id === id)?.skillIds ?? [] : [id]
    return [...catalog.agents.filter(agent => agent.id !== 'default' && (owner === 'plugin' && agent.pluginId === id || (owner === 'tool' ? agent.toolIds.includes(id) : agent.skillIds.some(skill => ids.includes(skill))))).map(agent => '智能体：' + agent.name),
      ...catalog.taskBindings.filter(binding => ids.includes(binding.skillId)).map(binding => '后台任务：' + binding.task)]
  }
  async importPreview(owner: CapabilityOwner, updating?: string, signal?: AbortSignal, sourcePath?: string) {
    if ((!sourcePath && !this.platform) || this.picking || this.openingVault()) throw new JotError('CONFLICT', '请等待系统目录选择完成')
    const database = this.core.state.raw
    this.picking = true
    try {
      const source = sourcePath ?? await this.platform!.pickDirectory(owner)
      if (!source) return null
      if (signal?.aborted) throw new JotError('CANCELLED', '操作已停止')
      return await this.core.mutate<import('@shared/capabilities').SkillImportPreview | import('@shared/capabilities').PluginImportPreview>(() => {
        if (signal?.aborted) throw new JotError('CANCELLED', '操作已停止')
        if (this.openingVault() || !this.core.state.isOpen || this.core.state.raw !== database) throw new JotError('CONFLICT', '库已切换，请重新选择')
        return owner === 'skill' ? this.skillImporter.preview(this.vault, this.core.index, source, updating) : this.pluginImporter.preview(this.vault, this.core.index, source, updating)
      })
    } finally { this.picking = false }
  }
  async importConfirm(owner: CapabilityOwner, token: string, name?: string, enabled?: boolean) {
    return this.mutate(async () => {
      if (owner === 'skill') {
        if (!name) throw new JotError('INVALID_INPUT', '请指定技能标识')
        await this.skillImporter.confirm(this.vault, this.core.index, token, name)
        if (enabled !== undefined) await changeSkill(this.vault, this.core.index, { action: 'enable', id: name, enabled })
      } else {
        const preview = this.pluginImporter.target(token)
        await this.pluginImporter.confirm(this.vault, this.core.index, token)
        if (enabled !== undefined) await setPluginEnabled(this.vault, this.core.index, preview, enabled)
      }
      return this.catalog()
    })
  }
  importCancel(owner: CapabilityOwner, token: string) { (owner === 'skill' ? this.skillImporter : this.pluginImporter).cancel(token) }
  async togglePlugin(id: string, enabled: boolean) { return this.mutate(() => setPluginEnabled(this.vault, this.core.index, id, enabled)) }
}

export function patchEntries(entries: PackageEntry[], files: CapabilityFileInput[]): PackageEntry[] {
  const next = new Map(entries.map(entry => [entry.path, entry]))
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new JotError('INVALID_INPUT', '修改路径不能重复')
  for (const file of files) {
    packageSegments(file.path)
    if (file.content === null) next.delete(file.path)
    else { const data = Buffer.from(file.content, 'utf8'); skillText(data); next.set(file.path, { path: file.path, data }) }
  }
  return [...next.values()]
}
