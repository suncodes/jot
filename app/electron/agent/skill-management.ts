import { randomUUID } from 'node:crypto'
import { missingSkillTools, type AssistantConfiguration, type CapabilityCatalog, type SkillChange, type SkillImportPreview } from '@shared/capabilities'
import { JotError } from '@shared/result'
import type { IndexService } from '../index/index'
import { readPackage, skillText, type PackageEntry } from '../vault/package-files'
import type { VaultService } from '../vault/vault'
import { capabilityCatalog } from './catalog'
import { parseSkill, renameSkill, skillMarkdown, skillPackageInfo } from './skills'
import { pluginSkillPackage } from './plugins'

function mainEntry(entries: PackageEntry[]): PackageEntry & { data: Buffer } {
  const main = entries.find(entry => entry.path === 'SKILL.md')
  if (!main?.data) throw new JotError('INVALID_INPUT', '所选目录缺少 SKILL.md')
  return { ...main, data: main.data }
}

async function nameTakenOnDisk(vault: VaultService, name: string): Promise<boolean> {
  return (await vault.skillFiles.directoryNames()).some(entry => entry.toLowerCase() === name)
}

async function nameTaken(vault: VaultService, name: string): Promise<boolean> {
  return nameTakenOnDisk(vault, name)
}

async function assertNewName(vault: VaultService, name: string): Promise<void> {
  if (await nameTaken(vault, name)) throw new JotError('CONFLICT', '技能标识已存在，请换一个标识')
}

function changeEnabled(config: AssistantConfiguration, id: string, enabled: boolean): void {
  if (enabled === !config.disabledSkillIds.includes(id)) return
  config.disabledSkillIds = enabled ? config.disabledSkillIds.filter(entry => entry !== id) : [...config.disabledSkillIds, id]
}

function skillEntries(name: string, entries: PackageEntry[], text: string): PackageEntry[] {
  const data = Buffer.from(text, 'utf8')
  skillText(data)
  if (parseSkill(text).name !== name) throw new JotError('INVALID_INPUT', '技能标识与安装目录不一致')
  return [{ path: 'SKILL.md', data }, ...entries.filter(entry => entry.path !== 'SKILL.md')]
}

export async function changeSkill(vault: VaultService, index: IndexService, change: SkillChange): Promise<CapabilityCatalog> {
  const config = await vault.getAssistantConfiguration()
  const previousDisabled = config.disabledSkillIds
  let writeFiles: (() => Promise<void>) | undefined
  const catalog = await capabilityCatalog(vault, index, config)
  if (change.action === 'save') {
    const { id, copyFrom, content, enabled } = change
    if (id && (id !== content.name || copyFrom)) throw new JotError('INVALID_INPUT', '现有技能的标识不可修改')
    const existing = catalog.skills.find(skill => skill.id === (id ?? copyFrom))
    if ((id || copyFrom) && !existing) throw new JotError('NOT_FOUND', '技能已移动或删除，请刷新后重试')
    if (id && existing?.pluginId) throw new JotError('INVALID_INPUT', '请复制为独立技能后调整')
    let entries: PackageEntry[] = []
    if (copyFrom && existing) {
      const plugin = catalog.plugins.find(plugin => plugin.id === existing.pluginId)
      entries = plugin ? await pluginSkillPackage(vault, plugin.source, plugin.id, existing.name) : await vault.skillFiles.package(copyFrom)
    }
    let prior = entries.length ? skillText(mainEntry(entries).data) : undefined
    if (id) prior = await vault.skillFiles.read(id)
    const text = skillMarkdown(content, prior)
    const installation = skillEntries(content.name, entries, text)
    if (id) writeFiles = () => vault.skillFiles.write(id, text)
    else {
      await assertNewName(vault, content.name)
      writeFiles = () => vault.skillFiles.install(content.name, installation)
    }
    changeEnabled(config, content.name, enabled)
  } else {
    const skill = catalog.skills.find(skill => skill.id === change.id)
    if (!skill) throw new JotError('NOT_FOUND', '技能已移动或删除，请刷新后重试')
    if (skill.pluginId && change.action !== 'enable') throw new JotError('INVALID_INPUT', '请在插件入口管理包内文件')
    if (change.action === 'enable') changeEnabled(config, skill.id, change.enabled)
    else {
      changeEnabled(config, skill.id, true)
      writeFiles = () => vault.skillFiles.remove(skill.id)
    }
  }

  const changed = previousDisabled !== config.disabledSkillIds
  if (changed) await vault.saveAssistantConfiguration(config)
  try {
    await writeFiles?.()
  } catch (error) {
    if (changed) {
      try { await vault.saveAssistantConfiguration({ ...config, disabledSkillIds: previousDisabled }) }
      catch { throw new JotError('IO_ERROR', '技能文件操作失败，启停配置也未能恢复。请刷新技能列表并检查库目录的访问权限。') }
    }
    throw error
  }
  return capabilityCatalog(vault, index, config)
}

/** 每个界面只保留一个目录预览，安装时使用这次预览读取的文件。 */
export class SkillImporter {
  private pending?: { token: string; vaultPath: string; entries: PackageEntry[]; updating?: string }

  clear(): void { this.pending = undefined }

  cancel(token: string): void {
    if (this.pending?.token === token) this.clear()
  }

  async preview(vault: VaultService, index: IndexService, source: string, updating?: string): Promise<SkillImportPreview> {
    this.clear()
    if (updating && !(await nameTakenOnDisk(vault, updating))) throw new JotError('NOT_FOUND', '更新目标不存在')
    const entries = await readPackage(source, 'SKILL.md')
    const skill = parseSkill(skillText(mainEntry(entries).data))
    const catalog = await capabilityCatalog(vault, index)
    const codexFile = entries.find(entry => entry.data && entry.path === 'agents/openai.yaml')
    let codexConfig = null
    let codexWarning = ''
    if (codexFile?.data) {
      try { codexConfig = skillText(codexFile.data) }
      catch { codexWarning = '无法读取 Codex 的 agents/openai.yaml。' }
    }
    const hasScripts = entries.some(entry => entry.data === null && entry.path.toLowerCase() === 'scripts')
    const { warnings, manualOnly } = skillPackageInfo(skill, hasScripts, codexConfig)
    if (codexWarning) warnings.push(codexWarning)
    if (manualOnly) warnings.push('用 / 或 $ 选择此技能后运行。')
    const missing = missingSkillTools(skill, catalog.tools.filter(tool => !tool.loader && tool.enabled).map(tool => tool.id))
    if (missing.length) warnings.push('当前 Jot 缺少技能所需工具：' + missing.join('、'))
    const conflict = await nameTaken(vault, skill.name)
    const token = randomUUID()
    this.pending = { token, vaultPath: vault.path, entries, updating }
    return {
      token, name: skill.name, suggestedName: updating ?? (conflict ? '' : skill.name), conflict: !updating && conflict, updating,
      removedFiles: updating ? (await vault.skillFiles.package(updating)).filter(entry => entry.data !== null && !entries.some(next => next.path === entry.path)).map(entry => entry.path) : [],
      title: skill.title, description: skill.description, requiredTools: skill.requiredTools,
      files: entries.filter(entry => entry.data !== null).map(entry => entry.path).sort(), warnings,
    }
  }

  async confirm(vault: VaultService, index: IndexService, token: string, name: string): Promise<CapabilityCatalog> {
    const preview = this.pending
    if (!preview || preview.token !== token || preview.vaultPath !== vault.path) {
      throw new JotError('CONFLICT', '技能导入预览已失效，请重新选择目录')
    }
    const config = await vault.getAssistantConfiguration()
    if (preview.updating) { if (preview.updating !== name) throw new JotError('INVALID_INPUT', '更新不能改变技能标识') }
    else await assertNewName(vault, name)
    const original = skillText(mainEntry(preview.entries).data)
    const skill = parseSkill(original)
    const entries = skillEntries(name, preview.entries, skill.name === name ? original : renameSkill(original, name))
    if (preview.updating) await vault.skillFiles.replace(name, entries)
    else await vault.skillFiles.install(name, entries)
    this.clear()
    return capabilityCatalog(vault, index, config)
  }
}
