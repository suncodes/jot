import { JotError } from './result'

const modifiers = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const
const specialKeys = ['Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ',', '.', '/', ';', '[', ']', '-', '=']
const reserved = new Set(['Ctrl+N', 'Ctrl+O', 'Ctrl+J', 'Ctrl+L', 'Ctrl+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+,', 'Ctrl+Shift+F', 'Ctrl+Shift+P', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y', 'Ctrl+S', 'Ctrl+F', 'Ctrl+E', 'Alt+F4'])

export function normalizeShortcut(value: string): string {
  const parts = value.split('+').map(part => part.trim())
  const key = parts.pop() ?? ''
  const keys = new Set(parts)
  if (!parts.length || keys.size !== parts.length || parts.some(part => !modifiers.includes(part as typeof modifiers[number])) || !parts.some(part => part !== 'Shift')) {
    throw new JotError('INVALID_INPUT', '快捷键需要 Ctrl、Alt 或 Meta 修饰键，且不能重复')
  }
  const normalizedKey = /^[a-z0-9]$/i.test(key) ? key.toUpperCase() : key
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(normalizedKey) && !specialKeys.includes(normalizedKey)) throw new JotError('INVALID_INPUT', '不支持的快捷键')
  return [...modifiers.filter(modifier => keys.has(modifier)), normalizedKey].join('+')
}

export function isReservedShortcut(value: string): boolean {
  return reserved.has(normalizeShortcut(value).replace('Meta+', 'Ctrl+'))
}

export function captureShortcut(value: string): string | null {
  try { return normalizeShortcut(value.replace(/CommandOrControl|CmdOrCtrl|Control/g, 'Ctrl').replace(/Command|Cmd/g, 'Meta')) }
  catch { return null }
}

export interface ShortcutKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
  repeat: boolean
  defaultPrevented: boolean
  getModifierState(key: string): boolean
}

/** 只转换可分发的组合键，保留输入法、已处理事件及原生文本移动／删除行为。 */
export function shortcutFromEvent(event: ShortcutKeyEvent, editing = false): string | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return null
  if (editing && /^(?:Backspace|Delete|Tab|Enter|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(event.key)) return null
  try {
    return normalizeShortcut([
      event.ctrlKey ? 'Ctrl' : '', event.metaKey ? 'Meta' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '',
      event.key === ' ' ? 'Space' : event.key,
    ].filter(Boolean).join('+'))
  } catch { return null }
}
