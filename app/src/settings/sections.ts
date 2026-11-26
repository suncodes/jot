import { t } from '@/strings'

export const SETTINGS_SECTIONS = ['vault', 'appearance', 'model', 'capture', 'shortcuts', 'extensions', 'storage', 'about'] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]

export function settingsSections(query: string): SettingsSection[] {
  const value = query.trim().toLocaleLowerCase()
  return SETTINGS_SECTIONS.filter(id => (t.settings.navigation[id] + ' ' + t.settings.keywords[id]).toLocaleLowerCase().includes(value))
}
