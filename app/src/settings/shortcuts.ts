import { captureShortcut, isReservedShortcut, normalizeShortcut } from '@shared/shortcut-keys'
import type { ShortcutConfiguration } from '@shared/app-extensions'
import { t } from '@/strings'

export function shortcutProblem(value: string, commandId: string, config: ShortcutConfiguration, capture: string): string {
  if (!value) return ''
  try {
    const next = normalizeShortcut(value)
    if (isReservedShortcut(next)) return t.shortcuts.reserved
    const comparable = (key: string) => key.replace('Meta+', 'Ctrl+')
    if (comparable(next) === comparable(captureShortcut(capture) ?? '')) return t.shortcuts.captureConflict
    if (config.bindings.some(binding => binding.commandId !== commandId && comparable(binding.hotkey) === comparable(next))) return t.shortcuts.conflict
    return ''
  } catch (e) { return (e as Error).message }
}
