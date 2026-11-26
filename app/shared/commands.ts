import type { AppExtensionIcon } from './app-extensions'

export const EXTENSION_IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
export const COMMAND_IDENTIFIER = /^(?:core\.(?:new-note|theme|command-palette)|extension:[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/

export function isAppExtensionId(value: string): boolean {
  return value.length <= 80 && EXTENSION_IDENTIFIER.test(value) && value !== 'core'
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)
}

export type CommandAvailability = { available: true } | { available: false; reason: string }
export type CommandSource = { kind: 'core' } | { kind: 'extension'; extensionId: string; profileId: string }

export interface AppCommand {
  id: string
  name: string
  icon: AppExtensionIcon
  source: CommandSource
  availability: CommandAvailability
}

export type CommandResult = { kind: 'open-note'; path: string; created: boolean } | { kind: 'theme'; theme: 'light' | 'dark' } | { kind: 'command-palette' }

export function extensionCommandId(extensionId: string, profileId: string, commandId: string): string {
  return `extension:${extensionId}:${profileId}:${commandId}`
}
