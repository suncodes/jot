import type { AppExtensionIcon, ShortcutConfiguration } from '@shared/app-extensions'
import { type AppCommand, type CommandAvailability, type CommandResult, EXTENSION_IDENTIFIER, extensionCommandId } from '@shared/commands'
import { previewDateNote, type DateNotePath, type DateNotePreview } from '@shared/date-paths'
import { previewWorkReportMonth, type WorkReportMonthPreview, type WorkReportOptions } from '@shared/work-reports'
import { JotError } from '@shared/result'
import { captureShortcut } from '@shared/shortcut-keys'
import type { Core } from '../core'
import { shortcutConfiguration } from '../extensions/schema'
import { resolveInVault } from '../vault/paths'

export interface CommandContext {
  vaultPath: string | null
  assertCurrent(): void
  mutate<T>(operation: () => Promise<T>): Promise<T>
}

interface RegisteredCommand {
  command: Omit<AppCommand, 'availability'>
  availability: () => CommandAvailability
  execute: (context: CommandContext) => Promise<CommandResult>
}

export interface ExtensionCommandRegistration {
  profileId: string
  commandId: string
  name: string
  icon: AppExtensionIcon
  availability: () => CommandAvailability
  execute: (context: CommandContext) => Promise<CommandResult>
}

export class CommandService {
  private readonly entries = new Map<string, RegisteredCommand>()
  private generation = 0
  private changingVault = false

  get isChangingVault(): boolean { return this.changingVault }

  constructor(private readonly core: Core, private readonly changed: () => void, private readonly systemDarkMode: () => boolean = () => false) {
    this.entries.set('core.new-note', {
      command: { id: 'core.new-note', name: '新建笔记', icon: 'file-plus', source: { kind: 'core' } },
      availability: () => this.core.vault.isOpen ? { available: true } : { available: false, reason: '请先打开笔记库' },
      execute: async context => {
        const meta = await context.mutate(() => this.core.vault.createNote({ title: '未命名笔记' }))
        await this.core.idle()
        return { kind: 'open-note', path: meta.path, created: true }
      },
    })
    this.entries.set('core.command-palette', {
      command: { id: 'core.command-palette', name: '打开命令面板', icon: 'command', source: { kind: 'core' } },
      availability: () => ({ available: true }),
      execute: async () => ({ kind: 'command-palette' }),
    })
    this.entries.set('core.theme', {
      command: { id: 'core.theme', name: '切换深浅主题', icon: 'sun-moon', source: { kind: 'core' } },
      availability: () => ({ available: true }),
      execute: async context => {
        const settings = await context.mutate(() => {
          const current = this.core.settings.get().appearance.theme
          const dark = current === 'dark' || current === 'system' && this.systemDarkMode()
          return this.core.settings.set({ appearance: { theme: dark ? 'light' : 'dark' } })
        })
        return { kind: 'theme', theme: settings.appearance.theme as 'light' | 'dark' }
      },
    })
  }

  list(input: { query?: string; availableOnly?: boolean } = {}): AppCommand[] {
    const query = input.query?.trim().toLocaleLowerCase() ?? ''
    return [...this.entries.values()].map(entry => ({ ...entry.command, source: { ...entry.command.source }, availability: this.availability(entry) }))
      .filter(command => (!input.availableOnly || command.availability.available) && (!query || (command.name + ' ' + command.id).toLocaleLowerCase().includes(query)))
  }

  private availability(entry: RegisteredCommand): CommandAvailability {
    return this.changingVault ? { available: false, reason: '正在切换笔记库' } : entry.availability()
  }

  async execute(id: string): Promise<CommandResult> {
    const entry = this.entries.get(id)
    if (!entry) throw new JotError('NOT_FOUND', '命令不存在或已停用')
    const availability = this.availability(entry)
    if (!availability.available) throw new JotError('WRITE_DENIED', availability.reason)
    const generation = this.generation
    const vaultPath = this.core.vault.isOpen ? this.core.vault.path : null
    const assertCurrent = () => {
      if (this.changingVault || generation !== this.generation || vaultPath !== (this.core.vault.isOpen ? this.core.vault.path : null)) throw new JotError('CONFLICT', '笔记库已切换，请重新执行命令')
    }
    const result = await entry.execute({ vaultPath, assertCurrent, mutate: operation => this.core.mutate(async () => { assertCurrent(); return operation() }) })
    assertCurrent()
    return result
  }

  replaceExtension(extensionId: string, registrations: ExtensionCommandRegistration[]): void {
    if (!EXTENSION_IDENTIFIER.test(extensionId) || extensionId === 'core' || extensionId.length > 80) throw new JotError('INVALID_INPUT', '应用插件标识无效')
    const replacements = new Map<string, RegisteredCommand>()
    for (const registration of registrations) {
      if (![registration.profileId, registration.commandId].every(value => value.length <= 80 && EXTENSION_IDENTIFIER.test(value))) throw new JotError('INVALID_INPUT', '命令或配置标识无效')
      const id = extensionCommandId(extensionId, registration.profileId, registration.commandId)
      if (replacements.has(id)) throw new JotError('CONFLICT', '命令标识重复：' + id)
      replacements.set(id, { command: { id, name: registration.name, icon: registration.icon, source: { kind: 'extension', extensionId, profileId: registration.profileId } }, availability: registration.availability, execute: registration.execute })
    }
    for (const [id, entry] of this.entries) if (entry.command.source.kind === 'extension' && entry.command.source.extensionId === extensionId) this.entries.delete(id)
    for (const [id, entry] of replacements) this.entries.set(id, entry)
    this.changed()
  }

  async changeVault<T>(operation: () => Promise<T>): Promise<T> {
    if (this.changingVault) throw new JotError('CONFLICT', '正在切换笔记库')
    this.changingVault = true
    this.generation++
    for (const [id, entry] of this.entries) if (entry.command.source.kind === 'extension') this.entries.delete(id)
    this.changed()
    try { return await operation() }
    finally { this.changingVault = false; this.changed() }
  }

  preview(input: DateNotePath): DateNotePreview {
    const result = previewDateNote(input, this.core.now())
    resolveInVault(this.core.vault.abs('content'), result.path.slice('content/'.length))
    return result
  }

  previewWorkReport(options: WorkReportOptions): WorkReportMonthPreview {
    const result = previewWorkReportMonth(options, this.core.now())
    resolveInVault(this.core.vault.abs('content'), result.dailyDraft.path.slice('content/'.length))
    return result
  }

  /** 配置和绑定共用校验，停用的有效配置仍可编辑快捷入口。 */
  async validateShortcuts(input: ShortcutConfiguration, additionalIds: string[] = []): Promise<ShortcutConfiguration> {
    const config = shortcutConfiguration.parse(input)
    const existing = await this.core.extensionState.getShortcuts()
    const known = new Set([...this.entries.keys(), ...existing.pinned, ...existing.bindings.map(binding => binding.commandId), ...additionalIds])
    const requested = [...config.pinned, ...config.bindings.map(binding => binding.commandId)]
    if (requested.some(id => !known.has(id))) {
      const extensions = await this.core.extensionState.getConfiguration()
      for (const [id, saved] of Object.entries(extensions.extensions)) {
        for (const profile of saved.profiles) known.add(extensionCommandId(id, profile.id, profile.commandId))
      }
    }
    for (const id of requested) {
      if (!known.has(id)) throw new JotError('NOT_FOUND', '命令不存在：' + id)
    }
    const capture = captureShortcut(this.core.settings.get().capture.hotkey)
    if (config.bindings.some(binding => binding.hotkey.replace('Meta+', 'Ctrl+') === capture?.replace('Meta+', 'Ctrl+'))) throw new JotError('CONFLICT', '快捷键与快速记录快捷键冲突')
    return config
  }

  saveShortcuts(input: ShortcutConfiguration): Promise<ShortcutConfiguration> {
    const config = shortcutConfiguration.parse(input)
    const generation = this.generation
    return this.core.mutate(async () => {
      if (this.changingVault || generation !== this.generation) throw new JotError('CONFLICT', '笔记库已切换，请重新保存快捷操作')
      await this.validateShortcuts(config)
      const result = await this.core.extensionState.saveShortcuts(config)
      this.changed()
      return result
    })
  }
}
