<script setup lang="ts">
import { MoreHorizontal, Plus } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '@/strings'
import { restoreObjectFocus } from '@/utils/objectFocus'
import type { MenuAction } from '@/utils/objectActions'

const { actions, label = t.actions.more, triggerId = 'object-more', menuId = 'object-menu', icon = 'more', primaryAction = undefined, descriptionId = undefined, prepare = undefined } = defineProps<{
  actions: MenuAction[]; label?: string; triggerId?: string; menuId?: string; icon?: 'more' | 'plus'; primaryAction?: string; descriptionId?: string; prepare?: () => Promise<void>
}>()
const emit = defineEmits<{ select: [id: string] }>()
const button = ref<HTMLButtonElement | null>(null)
const popup = ref<HTMLElement | null>(null)
const opened = ref(false)
const position = ref({ left: '0px', top: '0px' })
let row: HTMLElement | null = null
let returnFocus: HTMLElement | null = null
let request = 0
function close(restore = false): void {
  request++
  opened.value = false
  row?.removeAttribute('data-menu-open')
  document.removeEventListener('scroll', scroll, true)
  document.removeEventListener('focusin', focus)
  document.removeEventListener('wheel', scroll, true)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('blur', dismiss)
  if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
}
function dismiss(): void { close() }
function scroll(e: Event): void { if (!(e.target instanceof Node && popup.value?.contains(e.target))) close() }
function focus(e: FocusEvent): void { if (e.target instanceof Node && !popup.value?.contains(e.target)) close() }
function otherMenu(e: Event): void { if ((e as CustomEvent).detail !== button.value) close() }
async function open(e?: MouseEvent | KeyboardEvent): Promise<void> {
  if (opened.value) { close(true); return }
  const modal = document.querySelector('dialog[open]')
  if (modal && !modal.contains(button.value)) return
  if (!button.value?.getClientRects().length) return
  window.dispatchEvent(new CustomEvent('jot:menu-open', { detail: button.value }))
  const mine = ++request
  window.addEventListener('resize', dismiss)
  window.addEventListener('blur', dismiss)
  returnFocus = e instanceof KeyboardEvent && e.target instanceof HTMLElement ? e.target : e?.type === 'contextmenu' && row ? row.matches('[tabindex="0"]') ? row : row.querySelector<HTMLElement>('button, [tabindex="0"]') ?? row : button.value
  try { await prepare?.() } catch { if (mine === request) close(); return }
  // 等触发按钮带来的滚动完成，避免菜单刚展开就被滚动事件关闭。
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (mine !== request) return
  if (!button.value?.isConnected || !button.value.getClientRects().length || !actions.length) { close(); return }
  const currentModal = document.querySelector('dialog[open]')
  if (currentModal && !currentModal.contains(button.value)) { close(); return }
  const rect = button.value.getBoundingClientRect()
  const point = e instanceof MouseEvent && e.type === 'contextmenu' && (e.clientX || e.clientY)
    ? { x: e.clientX, y: e.clientY } : { x: rect.left, y: rect.bottom + 4 }
  position.value = { left: point.x + 'px', top: point.y + 'px' }
  opened.value = true
  row?.setAttribute('data-menu-open', '')
  await nextTick()
  if (!popup.value || !opened.value) return
  position.value = { left: Math.max(4, Math.min(point.x, innerWidth - popup.value.offsetWidth - 4)) + 'px', top: Math.max(4, Math.min(point.y, innerHeight - popup.value.offsetHeight - 4)) + 'px' }
  popup.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  document.addEventListener('scroll', scroll, true)
  document.addEventListener('focusin', focus)
  document.addEventListener('wheel', scroll, { capture: true, passive: true })
}
function isText(e: Event): boolean {
  const target = e.target instanceof Element ? e.target : null
  if (target?.closest('input, textarea, .cm-content, .selectable, [contenteditable=true]')) return true
  const selection = window.getSelection()
  return !!selection?.toString() && !!selection.anchorNode && !!target?.contains(selection.anchorNode)
}
function context(e: MouseEvent): void {
  if (e.defaultPrevented || isText(e)) return
  e.preventDefault()
  e.stopPropagation()
  void open(e)
}
function rowKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || isText(e)) return
  if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.metaKey)) return
  e.preventDefault()
  e.stopPropagation()
  void open(e)
}
function menuKey(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'Escape' || e.key === 'Tab') {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation() }
    close(true)
    return
  }
  const buttons = [...(popup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : e.key === 'ArrowDown' ? (index + 1) % buttons.length : e.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : -1
  if (next < 0) return
  e.preventDefault(); e.stopPropagation()
  buttons[next]?.focus({ preventScroll: true })
}
function choose(id: string): void { close(true); emit('select', id) }
onMounted(() => {
  row = button.value?.closest<HTMLElement>('[data-object-row]') ?? null
  row?.addEventListener('contextmenu', context)
  row?.addEventListener('keydown', rowKey)
  window.addEventListener('jot:menu-open', otherMenu)
})
onBeforeUnmount(() => {
  if (row?.contains(document.activeElement)) {
    const restore = restoreObjectFocus(document.activeElement as HTMLElement)
    void nextTick(restore)
  }
  close()
  row?.removeEventListener('contextmenu', context)
  row?.removeEventListener('keydown', rowKey)
  window.removeEventListener('jot:menu-open', otherMenu)
})
defineExpose({ open, close })
</script>
<template>
  <button ref="button" type="button" class="ghost icon-button object-more" :title="primaryAction ? undefined : label" :aria-label="label" :aria-describedby="descriptionId" :aria-haspopup="primaryAction ? undefined : 'menu'" :aria-expanded="primaryAction ? undefined : opened" :disabled="primaryAction ? actions.find(action => action.id === primaryAction)?.disabled : false" :data-testid="triggerId" @click.stop="primaryAction ? emit('select', primaryAction) : open($event)" @contextmenu="context" @keydown="rowKey"><slot><Plus v-if="icon === 'plus'" :size="16" /><MoreHorizontal v-else :size="16" /></slot></button>
  <Teleport :to="button?.closest('dialog') ?? 'body'">
    <div v-if="opened" class="object-menu-backdrop" @pointerdown.prevent="close(true)" @contextmenu.prevent="close(true)" />
    <div v-if="opened" ref="popup" class="object-menu" role="menu" :aria-label="label" :style="position" :data-testid="menuId" @keydown="menuKey">
      <button v-for="action in actions" :key="action.id" type="button" class="ghost" :class="{ danger: action.danger, separated: action.separated }" role="menuitem" tabindex="-1" :disabled="action.disabled" :data-testid="action.testId" @click.stop="choose(action.id)">{{ action.label }}</button>
    </div>
  </Teleport>
</template>
<style scoped>
.object-more { display:inline-grid; place-items:center; flex:none; }
.object-menu-backdrop { position:fixed; inset:0; z-index:1000; }
.object-menu { position:fixed; z-index:1001; width:208px; max-width:calc(100vw - 8px); max-height:calc(100vh - 8px); overflow:auto; padding:var(--space-1); background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-m); box-shadow:var(--shadow); }
.object-menu button { display:block; width:100%; text-align:left; padding:var(--space-2) var(--space-3); font-size:var(--font-size-small); }
.object-menu .danger { color:var(--danger); }
.object-menu .separated { border-top:1px solid var(--border); margin-top:var(--space-1); border-radius:0; }
</style>
