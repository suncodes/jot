import { randomUUID } from 'node:crypto'
import type { CapabilityCatalog, PluginImportPreview } from '@shared/capabilities'
import { JotError } from '@shared/result'
import type { IndexService } from '../index/index'
import type { VaultService } from '../vault/vault'
import { readPackage, validatePackageEntries, type PackageEntry } from '../vault/package-files'
import { capabilityCatalog } from './catalog'
import { pluginDependencies, previewPlugin } from './plugins'

export async function setPluginEnabled(vault: VaultService, index: IndexService, id: string, enabled: boolean): Promise<CapabilityCatalog> {
  const config = await vault.getAssistantConfiguration()
  const catalog = await capabilityCatalog(vault, index, config)
  const plugin = catalog.plugins.find(plugin => plugin.id === id)
  if (!plugin) throw new JotError('NOT_FOUND', '插件已移除，请刷新列表')
  const key = plugin.source === 'vault' ? 'enabledVaultPluginIds' : 'disabledBundledPluginIds'
  const include = plugin.source === 'vault' ? enabled : !enabled
  config[key] = config[key].filter(entry => entry !== id)
  if (include) config[key].push(id)
  await vault.saveAssistantConfiguration(config)
  return capabilityCatalog(vault, index, config)
}

export class PluginImporter {
  private pending?: { token: string; vaultPath: string; id: string; entries: PackageEntry[]; updating?: string }

  target(token: string): string { if (this.pending?.token !== token) throw new JotError('CONFLICT', '预览已失效'); return this.pending.id }
  clear(): void { this.pending = undefined }
  cancel(token: string): void { if (this.pending?.token === token) this.clear() }

  async preview(vault: VaultService, index: IndexService, source: string, updating?: string): Promise<PluginImportPreview> {
    this.clear()
    return this.previewEntries(vault, index, await readPackage(source, 'plugin.json'), updating)
  }

  async previewEntries(vault: VaultService, index: IndexService, entries: PackageEntry[], updating?: string): Promise<PluginImportPreview> {
    this.clear()
    validatePackageEntries(entries, 'plugin.json')
    const pkg = await previewPlugin(entries)
    if (pkg.issues.length) throw new JotError('INVALID_INPUT', pkg.issues.join('；'))
    const catalog = await capabilityCatalog(vault, index)
    if (updating && (pkg.id !== updating || !catalog.plugins.some(plugin => plugin.id === updating && plugin.source === 'vault'))) throw new JotError('INVALID_INPUT', '只能更新同标识的库内插件')
    if (!updating && (catalog.plugins.some(plugin => plugin.id === pkg.id)
      || (await vault.pluginFiles.directoryNames()).some(name => name.toLowerCase() === pkg.id))) {
      throw new JotError('CONFLICT', '插件标识已存在：' + pkg.id)
    }
    const tools = catalog.tools.filter(tool => !tool.loader && tool.enabled).map(tool => tool.id)
    const skills = [...catalog.skills, ...pkg.skills.map(skill => ({ ...skill, enabled: true }))]
    const token = randomUUID()
    this.pending = { token, vaultPath: vault.path, id: pkg.id, entries, updating }
    return {
      token, updating, removedFiles: updating ? (await vault.pluginFiles.package(updating)).filter(entry => entry.data !== null && !entries.some(next => next.path === entry.path)).map(entry => entry.path) : [], id: pkg.id, name: pkg.manifest.name, description: pkg.manifest.description,
      files: entries.filter(entry => entry.data !== null).map(entry => entry.path).sort(),
      issues: pluginDependencies(pkg, tools, skills),
    }
  }

  async publish(vault: VaultService, index: IndexService, token: string, commit?: () => Promise<void>): Promise<void> {
    const pending = this.pending
    if (!pending || pending.token !== token || pending.vaultPath !== vault.path) throw new JotError('CONFLICT', '插件预览已失效，请重新选择目录')
    const catalog = await capabilityCatalog(vault, index)
    if (!pending.updating && (catalog.plugins.some(plugin => plugin.id === pending.id)
      || (await vault.pluginFiles.directoryNames()).some(name => name.toLowerCase() === pending.id))) throw new JotError('CONFLICT', '插件标识已存在')
    if (pending.updating) await vault.pluginFiles.replace(pending.id, pending.entries, commit)
    else await vault.pluginFiles.install(pending.id, pending.entries, commit)
    this.clear()
  }

  async confirm(vault: VaultService, index: IndexService, token: string): Promise<CapabilityCatalog> {
    await this.publish(vault, index, token)
    return capabilityCatalog(vault, index)
  }
}
