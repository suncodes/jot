import { describe, expect, it } from 'vitest'
import { isReservedShortcut, shortcutFromEvent, type ShortcutKeyEvent } from '@shared/shortcut-keys'

const event = (changes: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: 'd', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true,
  defaultPrevented: false, repeat: false, isComposing: false, keyCode: 68,
  getModifierState: () => false, ...changes,
})

describe('应用内快捷键转换', () => {
  it('规范修饰键顺序、大小写、空格与 Meta', () => {
    expect(shortcutFromEvent(event())).toBe('Ctrl+Shift+D')
    expect(shortcutFromEvent(event({ ctrlKey: false, metaKey: true, key: ' ' }))).toBe('Meta+Shift+Space')
    expect(shortcutFromEvent(event({ altKey: true, key: 'F12' }))).toBe('Ctrl+Alt+Shift+F12')
  })
  it('忽略已处理、自动重复、输入法与 AltGraph 事件', () => {
    for (const changes of [{ defaultPrevented: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { getModifierState: (key: string) => key === 'AltGraph' }]) {
      expect(shortcutFromEvent(event(changes))).toBeNull()
    }
  })
  it('不把普通文字、死键与输入法中间键当命令', () => {
    for (const key of ['d', 'Process', 'Dead', 'Unidentified', 'Control']) {
      expect(shortcutFromEvent(event({ key, ctrlKey: false }))).toBeNull()
    }
  })
  it('输入区保留原生移动、换行、删除和焦点按键', () => {
    for (const key of ['Backspace', 'Delete', 'Tab', 'Enter', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(shortcutFromEvent(event({ key }), true)).toBeNull()
      expect(shortcutFromEvent(event({ key }), false)).toBe('Ctrl+Shift+' + key)
    }
    expect(shortcutFromEvent(event(), true)).toBe('Ctrl+Shift+D')
  })
  it('保留编辑切换和原快捷键，包括 Meta 等价键', () => {
    for (const key of ['Ctrl+E', 'Meta+E', 'Ctrl+A', 'Ctrl+S', 'Ctrl+N', 'Ctrl+O', 'Ctrl+Shift+P']) expect(isReservedShortcut(key)).toBe(true)
    expect(isReservedShortcut('Ctrl+Shift+D')).toBe(false)
  })
})
