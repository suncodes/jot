import type { WorkReportProfiles } from '@shared/work-reports'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ZodError } from 'zod'
import metadata from '../../package.json'
import type { AppExtensionCatalog, AppExtensionConfiguration, AppExtensionImportPreview, AppExtensionImportRequest, AppExtensionManifest, AppExtensionPackage, AppExtensionProfile, AppExtensionProfileInput, ManagedAppExtension, NoteTemplate, ProfileShortcutInput, ShortcutConfiguration } from '@shared/app-extensions'
import { extensionTemplates } from '@shared/app-extensions'
import { extensionCommandId, isAppExtensionId, type CommandAvailability } from '@shared/commands'
import { JotError } from '@shared/result'
import type { CapabilityCatalog, PluginImportPreview } from '@shared/capabilities'
import type { CommandContext } from '../commands/service'
import type { Core } from '../core'
import { PackageFiles, packageText, readPackage, type PackageEntry } from '../vault/package-files'
import { inspectAppExtension } from './packages'
import { appExtensionProfileInput, profileShortcutInput } from './schema'
import { validateNoteTemplate } from './templates'
import { compareVersions } from './versions'
import { AppExtensionAiPlugins } from './ai-plugin'

interface VaultScope { root: string; generation: number }
interface PendingImport {
  scope: VaultScope
  preview: AppExtensionImportPreview
  entries: PackageEntry[]
}
interface InspectedPackage { manifest: AppExtensionManifest; entries: PackageEntry[]; issues: string[] }

export interface AppExtensionPlatform {
  pickDirectory(purpose: 'extension'): Promise<string | null>
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const ownsCommand = (id: string, extensionId: string, profileId?: string) => id.startsWith('extension:' + extensionId + ':' + (profileId ? profileId + ':' : ''))
const settingsFor = (config: AppExtensionConfiguration, id: string) => Object.hasOwn(config.extensions, id) ? config.extensions[id] : undefined

export class AppExtensionManager {
  private generation = 0
  private picking = false
  private pending?: PendingImport
  private pendingAi?: { scope: VaultScope; token: string }
  private platform?: AppExtensionPlatform
  private registered = new Set<string>()
  readonly bundledFiles: PackageFiles
  private readonly aiPlugins: AppExtensionAiPlugins

  constructor(private readonly core: Core, bundledRoot: string, private readonly changed: () => void, private readonly aiChanged: () => void) {
    this.bundledFiles = new PackageFiles(() => bundledRoot, 'extension.json', isAppExtensionId)
    this.aiPlugins = new AppExtensionAiPlugins(core)
  }

  setPlatform(platform: AppExtensionPlatform): void { this.platform = platform }

  clear(): void {
    this.generation++
    this.pending = undefined
    this.pendingAi = undefined
    this.aiPlugins.clear()
    for (const id of this.registered) this.core.commands.replaceExtension(id, [])
    this.registered.clear()
  }

  private scope(): VaultScope {
    if (this.core.commands.isChangingVault) throw new JotError('CONFLICT', '正在切换笔记库，请稍后重试')
    return { root: this.core.vault.path, generation: this.generation }
  }

  private assertScope(scope: VaultScope): void {
    if (this.core.commands.isChangingVault || !this.core.vault.isOpen || this.core.vault.path !== scope.root || this.generation !== scope.generation) {
      throw new JotError('CONFLICT', '笔记库已切换，请重新操作应用插件')
    }
  }

  private mutate<T>(scope: VaultScope, operation: () => Promise<T>): Promise<T> {
    return this.core.mutate(async () => {
      this.assertScope(scope)
      try { return await operation() }
      catch (error) {
        if (error instanceof JotError) throw error
        if (error instanceof ZodError) throw new JotError('INVALID_INPUT', error.issues[0]?.message ?? '应用插件配置无效')
        throw new JotError('IO_ERROR', '应用插件操作失败：' + message(error))
      }
    })
  }

  catalog(): Promise<AppExtensionCatalog> {
    return this.mutate(this.scope(), () => this.reload())
  }

  private async inspect(id: string, files = this.core.vault.appExtensionFiles): Promise<InspectedPackage> {
    try {
      const entries = await files.package(id)
      const inspected = inspectAppExtension(entries, metadata.version)
      if (inspected.manifest.id !== id) throw new JotError('INVALID_INPUT', '应用插件目录名必须与清单 id 一致')
      return { ...inspected, entries }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new JotError('NOT_FOUND', '应用插件或清单文件不存在：' + id)
      throw error
    }
  }

  async workReportProfiles(): Promise<WorkReportProfiles> {
    const scope = this.scope()
    const config = await this.core.extensionState.getConfiguration()
    const result: WorkReportProfiles = { profiles: [], issues: [] }
    for (const [extensionId, saved] of Object.entries(config.extensions)) {
      try {
        const { manifest } = await this.inspect(extensionId)
        for (const profile of saved.profiles) {
          try {
            const command = this.profileCommand(manifest, profile)
            if (command.action !== 'work-diary' || !('root' in profile.options)) continue
            const { root, draftDirectory, reportDirectory, worklogDirectory, filename } = profile.options
            result.profiles.push({ extensionId, profileId: profile.id, name: profile.name, enabled: saved.enabled,
              paths: { root, draftDirectory, reportDirectory, worklogDirectory, filename } })
          } catch (error) { result.issues.push({ extensionId, message: profile.name + '：' + message(error) }) }
        }
      } catch (error) { result.issues.push({ extensionId, message: message(error) }) }
    }
    this.assertScope(scope)
    return result
  }
  private profileCommand(manifest: AppExtensionManifest, profile: AppExtensionProfile) {
    const command = manifest.commands.find(command => command.id === profile.commandId)
    if (!command) throw new JotError('NOT_FOUND', '清单中已不存在此配置对应的命令')
    if ((command.action === 'work-diary') !== ('root' in profile.options)) throw new JotError('INVALID_INPUT', '入口选项与清单动作不匹配，请重新配置')
    return command
  }

  private async validateProfile(manifest: AppExtensionManifest, profile: AppExtensionProfile, entries: PackageEntry[]): Promise<void> {
    this.profileCommand(manifest, profile)
    const options = profile.options
    if ('root' in options) {
      if (options.root !== null) this.core.commands.previewWorkReport(options)
    } else if (options.directory !== null) this.core.commands.preview({ directory: options.directory, filename: options.filename })
    for (const template of extensionTemplates(options)) await this.validateTemplate(manifest.id, template, entries)
  }

  private async validateTemplate(extensionId: string, template: NoteTemplate, entries: PackageEntry[]): Promise<void> {
    const text = template.kind === 'package' ? packageText(entries, template.path) : await this.core.templates.read(extensionId, template)
    if (text === null) throw new JotError('NOT_FOUND', '包内模板不存在：' + (template.kind === 'package' ? template.path : ''))
    validateNoteTemplate(text)
  }

  private async profileAvailability(pkg: Pick<AppExtensionPackage, 'manifest' | 'issues'>, profile: AppExtensionProfile, entries: PackageEntry[]): Promise<CommandAvailability> {
    if (!pkg.manifest) return { available: false, reason: pkg.issues.join('；') || '应用插件不可用' }
    if (compareVersions(metadata.version, pkg.manifest.minAppVersion) < 0) return { available: false, reason: pkg.issues.join('；') }
    try {
      this.profileCommand(pkg.manifest, profile)
      const options = profile.options
      if ('root' in options ? options.root === null : options.directory === null) {
        return { available: false, reason: 'root' in options ? '请选择工作根目录' : '请选择保存目录' }
      }
      const target = 'root' in options ? this.core.commands.previewWorkReport(options).dailyDraft
        : this.core.commands.preview({ directory: options.directory!, filename: options.filename })
      if (!await this.core.vault.noteTargetExists(target.path)) await this.validateTemplate(pkg.manifest.id, options.template, entries)
    } catch (error) { return { available: false, reason: message(error) } }
    return { available: true }
  }

  async reload(): Promise<AppExtensionCatalog> {
    const catalog: AppExtensionCatalog = { installed: [], candidates: [], issues: [] }
    let capabilities: Promise<CapabilityCatalog> | undefined
    const loadCapabilities = () => capabilities ??= this.core.capabilities.catalog()
    let config: AppExtensionConfiguration | null = null
    try { config = await this.core.extensionState.getConfiguration() }
    catch (error) { catalog.issues.push(message(error)) }
    let names: string[] | null = null
    try { names = await this.core.vault.appExtensionFiles.directories() }
    catch (error) { catalog.issues.push('已安装目录：' + message(error)) }
    const ids = [...new Set([...(names ?? []), ...Object.keys(config?.extensions ?? {})])].sort()
    for (const id of ids) {
      const saved = config ? settingsFor(config, id) : undefined
      const entry: ManagedAppExtension = { id, manifest: null, missing: names !== null && !names.includes(id), enabled: config ? saved?.enabled ?? false : null, profiles: [], issues: [], aiPlugin: null }
      let entries: PackageEntry[] = []
      try {
        if (names === null) throw new JotError('IO_ERROR', '应用插件目录无法读取')
        if (entry.missing) throw new JotError('NOT_FOUND', '应用插件目录已缺失，可卸载以清理所属配置和快捷引用')
        const inspected = await this.inspect(id)
        entry.manifest = inspected.manifest
        entry.issues = inspected.issues
        entries = inspected.entries
        entry.aiPlugin = await this.aiPlugins.describe(inspected.manifest, entries, loadCapabilities)
      } catch (error) { entry.issues.push(message(error)) }
      for (const profile of saved?.profiles ?? []) entry.profiles.push({ ...profile, availability: await this.profileAvailability(entry, profile, entries) })
      catalog.installed.push(entry)
    }
    try {
      for (const id of await this.bundledFiles.directories()) {
        try {
          const inspected = await this.inspect(id, this.bundledFiles)
          catalog.candidates.push({ id, manifest: inspected.manifest, issues: inspected.issues, aiPlugin: await this.aiPlugins.describe(inspected.manifest, inspected.entries, loadCapabilities) })
        } catch (error) { catalog.candidates.push({ id, manifest: null, issues: [message(error)], aiPlugin: null }) }
      }
    } catch (error) { catalog.issues.push('候选目录：' + message(error)) }
    const next = new Set<string>()
    for (const entry of catalog.installed) {
      if (!entry.enabled || !entry.manifest) continue
      const registrations = entry.profiles.flatMap(profile => {
        const command = entry.manifest!.commands.find(command => command.id === profile.commandId)
        if (!command) return []
        const snapshot: AppExtensionProfile = { id: profile.id, commandId: profile.commandId, name: profile.name, options: structuredClone(profile.options) }
        return [{ profileId: profile.id, commandId: profile.commandId, name: profile.name, icon: command.icon, availability: () => profile.availability,
          execute: (context: CommandContext) => {
            const options = snapshot.options
            return 'root' in options ? this.core.workDiary.execute(entry.id, options, context)
              : this.core.dateNotes.execute(entry.id, { ...snapshot, options }, context)
          } }]
      })
      this.core.commands.replaceExtension(entry.id, registrations)
      next.add(entry.id)
    }
    for (const id of this.registered) if (!next.has(id)) this.core.commands.replaceExtension(id, [])
    this.registered = next
    return catalog
  }

  async previewImport(input: AppExtensionImportRequest): Promise<AppExtensionImportPreview | null> {
    const scope = this.scope()
    if (this.picking) throw new JotError('CONFLICT', '请等待当前目录选择完成')
    this.pending = undefined
    this.picking = true
    try {
      let source: string | null = null
      if (input.source.kind === 'local') {
        if (!this.platform) throw new JotError('INTERNAL', '目录选择不可用')
        source = await this.platform.pickDirectory('extension')
        this.assertScope(scope)
        if (!source) return null
        if (!path.isAbsolute(source)) throw new JotError('INVALID_INPUT', '请选择完整的本地目录路径')
      }
      return await this.mutate(scope, async () => {
        const entries = input.source.kind === 'bundled' ? await this.bundledFiles.package(input.source.id) : await readPackage(source!, 'extension.json')
        const inspected = inspectAppExtension(entries, metadata.version)
        if (input.source.kind === 'bundled' && inspected.manifest.id !== input.source.id) throw new JotError('INVALID_INPUT', '候选目录名必须与清单 id 一致')
        const config = await this.core.extensionState.getConfiguration()
        const id = inspected.manifest.id
        const names = await this.core.vault.appExtensionFiles.directoryNames()
        if (input.updating) {
          if (input.updating !== id) throw new JotError('INVALID_INPUT', '更新不能改变应用插件标识')
          if (!names.includes(id)) throw new JotError('NOT_FOUND', '要更新的应用插件不存在')
        } else if (names.some(name => name.toLowerCase() === id) || settingsFor(config, id)) throw new JotError('CONFLICT', '应用插件标识已存在，请选择更新或先卸载缺失配置')
        let previousVersion: string | null = null
        let removedFiles: string[] = []
        const warnings: string[] = []
        if (input.updating) {
          try {
            const previous = await this.inspect(id)
            previousVersion = previous.manifest.version
            removedFiles = previous.entries.filter(entry => entry.data !== null && !entries.some(next => next.path === entry.path)).map(entry => entry.path)
          } catch { warnings.push('当前包损坏，本次更新将完整替换包资源并保留用户配置') }
          for (const profile of settingsFor(config, id)?.profiles ?? []) {
            if (!inspected.manifest.commands.some(command => command.id === profile.commandId)) warnings.push('配置“' + profile.name + '”的命令将不可用；配置和快捷引用仍保留')
            for (const template of extensionTemplates(profile.options)) {
              if (template.kind === 'package' && !entries.some(entry => entry.path === template.path && entry.data !== null)) warnings.push('配置“' + profile.name + '”使用的包内模板将缺失：' + template.path + '，请修改配置')
            }
          }
        }
        const preview: AppExtensionImportPreview = { token: randomUUID(), manifest: inspected.manifest, updating: !!input.updating, previousVersion,
          files: entries.filter(entry => entry.data !== null).map(entry => ({ path: entry.path, bytes: entry.data!.byteLength })).sort((left, right) => left.path.localeCompare(right.path)),
          removedFiles, issues: inspected.issues, warnings, aiPlugin: await this.aiPlugins.describe(inspected.manifest, entries) }
        this.pending = { scope, preview, entries }
        return structuredClone(preview)
      })
    } finally { this.picking = false }
  }

  cancelImport(token: string): void { if (this.pending?.preview.token === token) this.pending = undefined }

  previewAiPlugin(id: string): Promise<PluginImportPreview> {
    const scope = this.scope()
    return this.mutate(scope, async () => {
      this.pendingAi = undefined
      this.aiPlugins.clear()
      const pkg = await this.inspect(id)
      const preview = await this.aiPlugins.prepare(pkg.manifest, pkg.entries)
      this.pendingAi = { scope, token: preview.token }
      return preview
    })
  }

  confirmAiPlugin(token: string): Promise<AppExtensionCatalog> {
    return this.mutate(this.scope(), async () => {
      const pending = this.pendingAi
      if (!pending || pending.token !== token) throw new JotError('CONFLICT', 'AI 能力包预览已失效，请重新选择')
      this.assertScope(pending.scope)
      await this.aiPlugins.publish(token)
      this.pendingAi = undefined
      this.aiChanged()
      const catalog = await this.reload()
      this.changed()
      return catalog
    })
  }

  cancelAiPlugin(token: string): void {
    this.aiPlugins.cancel(token)
    if (this.pendingAi?.token === token) this.pendingAi = undefined
  }

  readTemplate(id: string, template: NoteTemplate): Promise<string> {
    return this.mutate(this.scope(), async () => {
      await this.inspect(id)
      return this.core.templates.read(id, template)
    })
  }

  copyTemplate(id: string, sourcePath: string, targetPath: string): Promise<{ path: string }> {
    return this.mutate(this.scope(), async () => {
      await this.inspect(id)
      return this.core.templates.copy(id, sourcePath, targetPath)
    })
  }

  private defaults(manifest: AppExtensionManifest) {
    return { enabled: false, profiles: manifest.commands.map(command => ({ id: command.id, commandId: command.id, name: command.name, options: structuredClone(command.defaults) })) }
  }

  confirmImport(token: string, installAiPlugin = false): Promise<AppExtensionCatalog> {
    const scope = this.scope()
    return this.mutate(scope, async () => {
      const pending = this.pending
      if (!pending || pending.preview.token !== token) throw new JotError('CONFLICT', '应用插件预览已失效，请重新选择')
      this.assertScope(pending.scope)
      if (pending.preview.issues.length) throw new JotError('INVALID_INPUT', pending.preview.issues.join('；'))
      const manifest = pending.preview.manifest
      const config = await this.core.extensionState.getConfiguration()
      const names = await this.core.vault.appExtensionFiles.directoryNames()
      if (pending.preview.updating) {
        if (!names.includes(manifest.id)) throw new JotError('NOT_FOUND', '要更新的应用插件不存在')
      } else if (names.some(name => name.toLowerCase() === manifest.id) || settingsFor(config, manifest.id)) throw new JotError('CONFLICT', '应用插件标识已存在')
      if (!settingsFor(config, manifest.id)) config.extensions[manifest.id] = this.defaults(manifest)
      const aiPreview = installAiPlugin ? await this.aiPlugins.prepare(manifest, pending.entries) : null
      const save = () => this.core.extensionState.saveChanges({ configuration: config })
      const commit = aiPreview ? () => this.aiPlugins.publish(aiPreview.token, save) : save
      if (pending.preview.updating) await this.core.vault.appExtensionFiles.replace(manifest.id, pending.entries, commit)
      else await this.core.vault.appExtensionFiles.install(manifest.id, pending.entries, commit)
      this.pending = undefined
      if (aiPreview) this.aiChanged()
      const catalog = await this.reload()
      this.changed()
      return catalog
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<AppExtensionCatalog> {
    return this.mutate(this.scope(), async () => {
      const config = await this.core.extensionState.getConfiguration()
      if (enabled) {
        const pkg = await this.inspect(id)
        if (pkg.issues.length) throw new JotError('WRITE_DENIED', pkg.issues.join('；'))
        if (!settingsFor(config, id)) config.extensions[id] = this.defaults(pkg.manifest)
      } else if (!settingsFor(config, id)) {
        const pkg = await this.inspect(id)
        config.extensions[id] = this.defaults(pkg.manifest)
      }
      config.extensions[id]!.enabled = enabled
      await this.core.extensionState.saveChanges({ configuration: config })
      const catalog = await this.reload()
      this.changed()
      return catalog
    })
  }

  saveProfile(id: string, input: AppExtensionProfileInput, shortcut?: ProfileShortcutInput): Promise<AppExtensionProfile> {
    const parsed = appExtensionProfileInput.parse(input)
    const entryShortcut = shortcut === undefined ? undefined : profileShortcutInput.parse(shortcut)
    return this.mutate(this.scope(), async () => {
      const pkg = await this.inspect(id)
      if (pkg.issues.length) throw new JotError('WRITE_DENIED', pkg.issues.join('；'))
      if (!pkg.manifest.commands.some(command => command.id === parsed.commandId)) throw new JotError('NOT_FOUND', '清单中不存在此命令')
      const config = await this.core.extensionState.getConfiguration()
      const saved = settingsFor(config, id) ?? { enabled: false, profiles: [] }
      config.extensions[id] = saved
      const previous = parsed.id ? saved.profiles.find(profile => profile.id === parsed.id) : undefined
      if (parsed.id && !previous) throw new JotError('NOT_FOUND', '入口配置已不存在')
      if (previous && previous.commandId !== parsed.commandId) throw new JotError('INVALID_INPUT', '现有入口不能更换清单命令，请新建入口')
      const profile: AppExtensionProfile = { ...parsed, id: previous?.id ?? 'profile-' + randomUUID() }
      await this.validateProfile(pkg.manifest, profile, pkg.entries)
      if (previous) saved.profiles = saved.profiles.map(current => current.id === profile.id ? profile : current)
      else saved.profiles.push(profile)
      let shortcuts: ShortcutConfiguration | undefined
      if (entryShortcut) {
        const commandId = extensionCommandId(id, profile.id, profile.commandId)
        const next = await this.core.extensionState.getShortcuts()
        next.pinned = next.pinned.filter(current => current !== commandId || entryShortcut.pinned)
        if (entryShortcut.pinned && !next.pinned.includes(commandId)) next.pinned.push(commandId)
        next.bindings = next.bindings.filter(binding => binding.commandId !== commandId)
        if (entryShortcut.hotkey) next.bindings.push({ commandId, hotkey: entryShortcut.hotkey })
        shortcuts = await this.core.commands.validateShortcuts(next, [commandId])
      }
      await this.core.extensionState.saveChanges({ configuration: config, shortcuts })
      await this.reload()
      this.changed()
      return profile
    })
  }

  removeProfile(id: string, profileId: string): Promise<AppExtensionCatalog> {
    return this.mutate(this.scope(), async () => {
      const config = await this.core.extensionState.getConfiguration()
      const saved = settingsFor(config, id)
      if (!saved?.profiles.some(profile => profile.id === profileId)) throw new JotError('NOT_FOUND', '入口配置已不存在')
      saved.profiles = saved.profiles.filter(profile => profile.id !== profileId)
      const shortcuts = await this.core.extensionState.getShortcuts()
      shortcuts.pinned = shortcuts.pinned.filter(command => !ownsCommand(command, id, profileId))
      shortcuts.bindings = shortcuts.bindings.filter(binding => !ownsCommand(binding.commandId, id, profileId))
      await this.core.extensionState.saveChanges({ configuration: config, shortcuts })
      const catalog = await this.reload()
      this.changed()
      return catalog
    })
  }

  uninstall(id: string): Promise<AppExtensionCatalog> {
    return this.mutate(this.scope(), async () => {
      const config = await this.core.extensionState.getConfiguration()
      const names = await this.core.vault.appExtensionFiles.directoryNames()
      if (!names.includes(id) && !settingsFor(config, id)) throw new JotError('NOT_FOUND', '应用插件不存在')
      const shortcuts = await this.core.extensionState.getShortcuts()
      delete config.extensions[id]
      shortcuts.pinned = shortcuts.pinned.filter(command => !ownsCommand(command, id))
      shortcuts.bindings = shortcuts.bindings.filter(binding => !ownsCommand(binding.commandId, id))
      const commit = () => this.core.extensionState.saveChanges({ configuration: config, shortcuts })
      if (names.includes(id)) await this.core.vault.appExtensionFiles.remove(id, commit)
      else await commit()
      const catalog = await this.reload()
      this.changed()
      return catalog
    })
  }
}
