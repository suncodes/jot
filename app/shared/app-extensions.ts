import type { CommandAvailability } from './commands'
import type { WorkReportOptions } from './work-reports'

export const APP_EXTENSION_SCHEMA_VERSION = 1
export const APP_EXTENSION_API_VERSION = 1
export const APP_EXTENSION_ICONS = ['book-open', 'briefcase-business', 'calendar-days', 'file-plus', 'lightbulb', 'notebook-pen', 'sun-moon', 'command'] as const
export type AppExtensionIcon = typeof APP_EXTENSION_ICONS[number]

export type NoteTemplate = { kind: 'none' } | { kind: 'package'; path: string } | { kind: 'user'; path: string }

export interface DailyNoteOptions {
  directory: string | null
  filename: string
  template: NoteTemplate
}

export type AppExtensionOptions = DailyNoteOptions | WorkReportOptions

export const extensionTemplates = (options: AppExtensionOptions): NoteTemplate[] =>
  'root' in options && options.okrTemplate !== null ? [options.template, options.okrTemplate] : [options.template]

export type AppExtensionCommand = {
  id: string
  name: string
  icon: AppExtensionIcon
} & (
  | { action: 'daily-note'; defaults: DailyNoteOptions }
  | { action: 'work-diary'; defaults: WorkReportOptions }
)

export interface AppExtensionManifest {
  schemaVersion: 1
  apiVersion: 1
  id: string
  name: string
  version: string
  description: string
  minAppVersion: string
  commands: AppExtensionCommand[]
  aiPlugin?: { path: string }
}

export interface AppExtensionProfile<Options extends AppExtensionOptions = AppExtensionOptions> {
  id: string
  commandId: string
  name: string
  options: Options
}

export type DailyNoteProfile = AppExtensionProfile<DailyNoteOptions>

export interface AppExtensionConfiguration {
  schemaVersion: 1
  extensions: Record<string, { enabled: boolean; profiles: AppExtensionProfile[] }>
}

export interface ShortcutConfiguration {
  schemaVersion: 1
  pinned: string[]
  bindings: { commandId: string; hotkey: string }[]
}

export const createAppExtensionConfiguration = (): AppExtensionConfiguration => ({ schemaVersion: 1, extensions: {} })
export const createShortcutConfiguration = (): ShortcutConfiguration => ({ schemaVersion: 1, pinned: [], bindings: [] })

export interface AppExtensionPackage {
  id: string
  manifest: AppExtensionManifest | null
  issues: string[]
  aiPlugin: AppExtensionAiPlugin | null
}

export interface AppExtensionAiPlugin {
  id: string | null
  name: string
  description: string
  files: string[]
  issues: string[]
  installation:
    | { kind: 'missing' }
    | { kind: 'installed'; source: 'bundled' | 'vault'; enabled: boolean; issues: string[] }
    | { kind: 'occupied'; reason: string }
}

export interface ManagedAppExtension extends AppExtensionPackage {
  missing: boolean
  enabled: boolean | null
  profiles: (AppExtensionProfile & { availability: CommandAvailability })[]
}

export interface AppExtensionCatalog {
  installed: ManagedAppExtension[]
  candidates: AppExtensionPackage[]
  issues: string[]
}

export interface AppExtensionImportRequest {
  source: { kind: 'local' } | { kind: 'bundled'; id: string }
  updating?: string
}

export interface AppExtensionImportPreview {
  token: string
  manifest: AppExtensionManifest
  updating: boolean
  previousVersion: string | null
  files: { path: string; bytes: number }[]
  removedFiles: string[]
  issues: string[]
  warnings: string[]
  aiPlugin: AppExtensionAiPlugin | null
}

export type AppExtensionProfileInput = Omit<AppExtensionProfile, 'id'> & { id?: string }

export interface ProfileShortcutInput {
  pinned: boolean
  hotkey: string | null
}
