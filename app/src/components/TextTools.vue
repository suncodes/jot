<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue'
import { applyTextAction, editorAt, historyAvailable, preserveTextSelection, selectedText, type TextAction } from '@/utils/textActions'
import { t } from '@/strings'

const menu = reactive({ open: false, x: 0, y: 0, selection: '', editable: false, undo: false, redo: false })
const target = shallowRef<HTMLElement | null>(null)
const popup = ref<HTMLElement | null>(null)
const error = ref('')
let restoreSelection = () => {}
let menuRequest = 0
const labels: Record<TextAction, string> = t.textTools.actions
const shortcuts: Partial<Record<TextAction, string>> = { undo: 'Ctrl+Z', redo: 'Ctrl+Y', cut: 'Ctrl+X', copy: 'Ctrl+C', paste: 'Ctrl+V', selectAll: 'Ctrl+A', find: 'Ctrl+F', edit: 'Ctrl+E' }
const actions = computed(() => {
  const element = target.value
  if (element instanceof HTMLInputElement && element.type === 'password') return menu.editable ? ['paste', 'selectAll'] as TextAction[] : ['selectAll'] as TextAction[]
  const list: TextAction[] = menu.editable ? ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] : ['copy', 'copyAll', 'selectAll']
  if (element?.dataset.markdown !== undefined) list.push('copyMarkdown')
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element?.closest('[data-find-scope]')?.querySelector('[data-find-target]')) list.push('find')
  if (element?.hasAttribute('data-text-edit')) list.push('edit')
  return list
})
function disabled(action: TextAction): boolean {
  if ((action === 'copy' || action === 'cut') && !menu.selection) return true
  return (action === 'undo' || action === 'redo') && !menu[action]
}
function textTarget(node: EventTarget | null): HTMLElement | null {
  const element = node instanceof Element ? node.closest<HTMLElement>('.cm-content, textarea, input, .selectable') : null
  if (!element || element.closest('[data-testid="text-menu"]')) return null
  if (element instanceof HTMLInputElement && !['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(element.type)) return null
  return element
}
async function openMenu(element: HTMLElement, x: number, y: number): Promise<void> {
  const request = ++menuRequest
  target.value = element
  restoreSelection = preserveTextSelection(element)
  restoreSelection()
  const view = editorAt(element)
  menu.editable = view ? !view.state.readOnly : (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && !element.readOnly && !element.disabled
  menu.selection = selectedText(element)
  menu.undo = menu.editable && historyAvailable(element, 'undo')
  menu.redo = menu.editable && historyAvailable(element, 'redo')
  menu.x = x
  menu.y = y
  error.value = ''
  // 原生焦点可能引起容器滚动；先完成这一帧，再展开菜单。
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (request !== menuRequest || !element.isConnected) return
  window.dispatchEvent(new CustomEvent('jot:menu-open', { detail: element }))
  menu.open = true
  await nextTick()
  if (!menu.open || target.value !== element || !popup.value) return
  menu.x = Math.max(4, Math.min(x, innerWidth - popup.value.offsetWidth - 4))
  menu.y = Math.max(4, Math.min(y, innerHeight - popup.value.offsetHeight - 4))
  popup.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
}
function context(e: MouseEvent): void {
  if (e.defaultPrevented) return
  const element = textTarget(e.target)
  if (!element) return
  e.preventDefault()
  void openMenu(element, e.clientX, e.clientY)
}
function closeMenu(restoreFocus = true): void {
  menuRequest++
  if (!menu.open) return
  menu.open = false
  if (restoreFocus) restoreSelection()
}
async function run(action: TextAction): Promise<void> {
  const element = target.value
  if (!element?.isConnected || disabled(action)) return
  closeMenu()
  try {
    await applyTextAction(element, action, menu.selection)
  } catch { error.value = t.textTools.failed }
}
function onKey(e: KeyboardEvent): void {
  if (e.isComposing || e.defaultPrevented) return
  if (e.key === 'Escape') {
    if (menu.open) { e.preventDefault(); e.stopPropagation(); closeMenu() }
    error.value = ''
  } else if (e.key === 'Tab' && menu.open) closeMenu()
  else if (e.key === 'ContextMenu' || (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'F10')) {
    const element = textTarget(e.target) ?? (document.activeElement === document.body ? textTarget(window.getSelection()?.anchorNode?.parentElement ?? null) : null)
    if (menu.open) { e.preventDefault(); e.stopPropagation(); closeMenu(); return }
    if (!element) return
    e.preventDefault()
    e.stopPropagation()
    const view = editorAt(element)
    const caret = view?.coordsAtPos(view.state.selection.main.head)
    const selection = window.getSelection()
    const range = !view && selectedText(element) && selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
    const rect = caret ?? range ?? element.getBoundingClientRect()
    void openMenu(element, rect.left, rect.bottom)
  }
}
function menuKey(e: KeyboardEvent): void {
  const buttons = [...(popup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  let index: number
  if (e.key === 'Home') index = 0
  else if (e.key === 'End') index = buttons.length - 1
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') index = (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  else return
  e.preventDefault()
  e.stopPropagation()
  buttons[index]?.focus({ preventScroll: true })
}
function dismiss(): void { closeMenu() }
function otherMenu(e: Event): void { if ((e as CustomEvent).detail !== target.value) closeMenu(false) }
function onScroll(e: Event): void {
  if (!menu.open) return
  if (e.target instanceof Node && popup.value?.contains(e.target)) return
  closeMenu()
}
function onFocus(e: FocusEvent): void {
  if (menu.open && e.target instanceof Node && !popup.value?.contains(e.target)) closeMenu(false)
}
onMounted(() => {
  document.addEventListener('contextmenu', context)
  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('wheel', onScroll, { capture: true, passive: true })
  document.addEventListener('focusin', onFocus)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('jot:menu-open', otherMenu)
  window.addEventListener('resize', dismiss)
  window.addEventListener('blur', dismiss)
})
onBeforeUnmount(() => {
  document.removeEventListener('contextmenu', context)
  document.removeEventListener('scroll', onScroll, true)
  document.removeEventListener('wheel', onScroll, true)
  document.removeEventListener('focusin', onFocus)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('jot:menu-open', otherMenu)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('blur', dismiss)
})
</script>

<template>
  <Teleport :to="target?.closest('dialog') ?? 'body'">
    <div v-if="menu.open" class="text-menu-backdrop" @pointerdown.prevent="closeMenu()" @contextmenu.prevent="closeMenu()" />
    <div v-if="menu.open" ref="popup" class="text-menu" role="menu" :aria-label="t.textTools.menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" data-testid="text-menu" @keydown="menuKey">
      <button v-for="action in actions" :key="action" type="button" class="ghost" role="menuitem" tabindex="-1" :disabled="disabled(action)" :data-testid="'text-' + action" @mousedown.prevent @click="run(action)"><span>{{ labels[action] }}</span><kbd>{{ shortcuts[action] }}</kbd></button>
    </div>
    <div v-if="error" class="text-error" role="alert" @click="error = ''">{{ error }}</div>
  </Teleport>
</template>

<style scoped>
.text-menu-backdrop { position:fixed; inset:0; z-index:1000; }
.text-menu { position:fixed; z-index:1001; width:212px; max-height:calc(100vh - 8px); overflow:auto; padding:var(--space-1); background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-m); box-shadow:var(--shadow); }
.text-menu button { display:flex; justify-content:space-between; align-items:center; width:100%; padding:var(--space-2) var(--space-3); text-align:left; }
kbd { font:inherit; color:var(--text-faint); font-size:var(--font-size-small); }
.text-error { position:fixed; bottom:24px; right:24px; z-index:1002; background:var(--bg-primary); border:1px solid var(--border); padding:var(--space-3); border-radius:var(--radius-m); color:var(--danger); }
</style>
