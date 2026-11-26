import type { AppExtensionAiPlugin, AppExtensionManifest } from '@shared/app-extensions'
import type { PluginImportPreview } from '@shared/capabilities'
import { JotError } from '@shared/result'
import type { Core } from '../core'
import { PluginImporter } from '../agent/plugin-management'
import { previewPlugin } from '../agent/plugins'
import { packageSegments, validatePackageEntries, type PackageEntry } from '../vault/package-files'

function pluginEntries(manifest: AppExtensionManifest, entries: PackageEntry[]): PackageEntry[] {
  if (!manifest.aiPlugin) throw new JotError('NOT_FOUND', '此应用插件没有附带 AI 能力包')
  packageSegments(manifest.aiPlugin.path)
  const prefix = manifest.aiPlugin.path + '/'
  return entries.filter(entry => entry.path.startsWith(prefix)).map(entry => ({ ...entry, path: entry.path.slice(prefix.length) }))
}

export class AppExtensionAiPlugins {
  private readonly importer = new PluginImporter()

  constructor(private readonly core: Core) {}

  clear(): void { this.importer.clear() }
  cancel(token: string): void { this.importer.cancel(token) }

  async describe(manifest: AppExtensionManifest, entries: PackageEntry[], catalog = () => this.core.capabilities.catalog()): Promise<AppExtensionAiPlugin | null> {
    if (!manifest.aiPlugin) return null
    const result: AppExtensionAiPlugin = { id: null, name: 'AI 能力包', description: '', files: [], issues: [], installation: { kind: 'missing' } }
    try {
      const nested = pluginEntries(manifest, entries)
      result.files = nested.filter(entry => entry.data !== null).map(entry => entry.path).sort()
      validatePackageEntries(nested, 'plugin.json')
      const pkg = await previewPlugin(nested)
      result.id = pkg.id; result.name = pkg.manifest.name; result.description = pkg.manifest.description; result.issues = pkg.issues
      const installed = (await catalog()).plugins.find(plugin => plugin.id === pkg.id)
      if (installed) result.installation = { kind: 'installed', source: installed.source, enabled: installed.enabled, issues: installed.issues }
      else if ((await this.core.vault.pluginFiles.directoryNames()).some(name => name.toLowerCase() === pkg.id)) {
        result.installation = { kind: 'occupied', reason: '同标识的能力包目录已存在，请到智能体模块检查' }
      }
    } catch (error) { result.issues.push(error instanceof Error ? error.message : String(error)) }
    return result
  }

  async prepare(manifest: AppExtensionManifest, entries: PackageEntry[]): Promise<PluginImportPreview> {
    const source = await this.describe(manifest, entries)
    if (!source) throw new JotError('NOT_FOUND', '此应用插件没有附带 AI 能力包')
    if (source.issues.length) throw new JotError('INVALID_INPUT', source.issues.join('；'))
    if (source.installation.kind !== 'missing') throw new JotError('CONFLICT', source.installation.kind === 'installed'
      ? 'AI 能力包已安装，请在智能体模块独立管理：' + source.id : source.installation.reason)
    return this.importer.previewEntries(this.core.vault, this.core.index, pluginEntries(manifest, entries))
  }

  publish(token: string, commit?: () => Promise<void>): Promise<void> {
    return this.importer.publish(this.core.vault, this.core.index, token, commit)
  }
}
