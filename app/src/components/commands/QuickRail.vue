<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch, type CSSProperties } from 'vue'
import { Command } from 'lucide-vue-next'
import type { AppCommand } from '@shared/commands'
import { commandIcons } from '@/settings/icons'
import { useExtensionsStore } from '@/stores/extensions'
import { useCommandsStore } from '@/stores/commands'
import { t } from '@/strings'
import ObjectMenu from '@/components/ObjectMenu.vue'
import type { MenuAction } from '@/utils/objectActions'

const extensions = useExtensionsStore(), commands = useCommandsStore()
const list = computed(() => extensions.pinnedCommands)
const tooltipId = useId()
const hint = ref<{ id: string; name: string; hotkey: string } | null>(null)
const tooltip = ref<HTMLElement | null>(null)
const position = ref<CSSProperties>({})
let hintRequest = 0

function hideHint(): void { hintRequest++; hint.value = null }
async function showHint(event: Event, id: string, name: string): Promise<void> {
  if (!(event.currentTarget instanceof HTMLElement) || document.querySelector('dialog[open]')) return
  const request = ++hintRequest, rect = event.currentTarget.getBoundingClientRect()
  hint.value = { id, name, hotkey: extensions.displayBinding(id) }
  position.value = { left: rect.right + 8 + 'px', top: rect.top + 'px', visibility: 'hidden' }
  await nextTick()
  if (request !== hintRequest || !tooltip.value) return
  position.value = { left: Math.min(rect.right + 8, innerWidth - tooltip.value.offsetWidth - 8) + 'px',
    top: Math.max(8, Math.min(rect.top + (rect.height - tooltip.value.offsetHeight) / 2, innerHeight - tooltip.value.offsetHeight - 8)) + 'px' }
}
function actions(command: AppCommand): MenuAction[] {
  const index = list.value.findIndex(item => item.id === command.id)
  return [
    { id: 'execute', label: t.shortcuts.execute, disabled: extensions.busy || commands.running.has(command.id), testId: 'quick-action-execute' },
    ...(command.source.kind === 'extension' ? [{ id: 'configure', label: t.commandPalette.configure, disabled: extensions.busy, testId: 'quick-action-configure' }] : []),
    { id: 'up', label: t.shortcuts.up, separated: true, disabled: extensions.busy || index === 0, testId: 'quick-action-up' },
    { id: 'down', label: t.shortcuts.down, disabled: extensions.busy || index === list.value.length - 1, testId: 'quick-action-down' },
    { id: 'unpin', label: t.shortcuts.unpin, disabled: extensions.busy, testId: 'quick-action-unpin' },
    { id: 'manage', label: t.commandPalette.manage, separated: true, testId: 'quick-action-manage' },
  ]
}
function choose(action: string, command: AppCommand): void {
  hideHint()
  if (action === 'execute') void commands.execute(command.id)
  else if (action === 'configure') commands.configure(command)
  else if (action === 'up' || action === 'down') void commands.movePin(command.id, action === 'up' ? -1 : 1)
  else if (action === 'unpin') void commands.togglePin(command.id)
  else if (action === 'manage') commands.manage()
}
watch(() => JSON.stringify(list.value.map(command => [command.id, command.name, extensions.displayBinding(command.id)])), () => {
  if (!hint.value || hint.value.id === 'core.command-palette') return
  const command = list.value.find(command => command.id === hint.value?.id)
  if (!command) hideHint()
  else hint.value = { id: command.id, name: command.name, hotkey: extensions.displayBinding(command.id) }
})
onMounted(() => {
  window.addEventListener('resize', hideHint)
  window.addEventListener('blur', hideHint)
  window.addEventListener('jot:menu-open', hideHint)
})
onUnmounted(() => {
  window.removeEventListener('resize', hideHint)
  window.removeEventListener('blur', hideHint)
  window.removeEventListener('jot:menu-open', hideHint)
})
</script>
<template>
  <nav v-if="list.length" class="quick-rail" :aria-label="t.shortcuts.title" data-testid="quick-rail">
    <div class="rail-commands" data-object-list @scroll="hideHint">
      <div v-for="command in list" :key="command.id" class="rail-item" data-object-row data-testid="quick-command" :data-command="command.id" @pointerenter="showHint($event, command.id, command.name)" @pointerleave="hideHint" @focusin="showHint($event, command.id, command.name)" @focusout="hideHint">
        <ObjectMenu :label="command.name" :description-id="hint?.id === command.id ? tooltipId : undefined" :trigger-id="'quick-run-' + command.id" menu-id="quick-command-menu" primary-action="execute" :actions="actions(command)" @select="choose($event, command)"><component :is="commandIcons[command.icon]" :size="18" /></ObjectMenu>
      </div>
    </div>
    <div class="rail-footer" @pointerenter="showHint($event, 'core.command-palette', t.commandPalette.title)" @pointerleave="hideHint" @focusin="showHint($event, 'core.command-palette', t.commandPalette.title)" @focusout="hideHint"><button class="ghost rail-button" :aria-label="t.commandPalette.title" :aria-describedby="hint?.id === 'core.command-palette' ? tooltipId : undefined" data-testid="quick-palette" @click="hideHint(); commands.execute('core.command-palette')"><Command :size="18" /></button></div>
    <Teleport to="body"><div v-if="hint" :id="tooltipId" ref="tooltip" class="rail-tooltip" role="tooltip" data-testid="quick-tooltip" :style="position"><span>{{ hint.name }}</span><kbd v-if="hint.hotkey">{{ hint.hotkey }}</kbd></div></Teleport>
  </nav>
</template>
<style scoped>
.quick-rail { width:var(--quick-rail-width); flex:0 0 var(--quick-rail-width); min-height:0; display:flex; flex-direction:column; align-items:center; padding:var(--space-2) 0; border-right:1px solid var(--border); }
.rail-commands { min-height:0; overflow-y:auto; scrollbar-width:none; display:flex; flex-direction:column; align-items:center; gap:var(--space-2); width:100%; }
.rail-commands::-webkit-scrollbar { display:none; }
.rail-item { width:var(--command-button-size); height:var(--command-button-size); flex:none; }
.rail-item :deep(.object-more), .rail-button { opacity:1; display:grid; place-items:center; width:var(--command-button-size); height:var(--command-button-size); min-height:0; padding:0; color:var(--text-muted); border-radius:var(--radius-s); }
.rail-item :deep(.object-more:hover), .rail-button:hover, .rail-item[data-menu-open] :deep(.object-more) { color:var(--accent); background:var(--accent-soft); }
.rail-item :deep(.object-more:focus-visible), .rail-button:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.rail-footer { flex:none; margin-top:auto; padding-top:var(--space-3); }
.rail-tooltip { position:fixed; z-index:900; display:flex; gap:var(--space-4); align-items:center; max-width:calc(100vw - var(--space-8)); padding:var(--space-2) var(--space-3); border:1px solid var(--border); border-radius:var(--radius-s); background:var(--bg-primary); box-shadow:var(--shadow); color:var(--text-normal); font-size:var(--font-size-small); pointer-events:none; }
.rail-tooltip span { overflow-wrap:anywhere; }.rail-tooltip kbd { font:var(--font-size-small) var(--font-mono); white-space:nowrap; color:var(--text-muted); }
</style>
