<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { Command, Pin } from 'lucide-vue-next'
import AppDialog from '@/components/AppDialog.vue'
import { useExtensionsStore } from '@/stores/extensions'
import { useCommandsStore } from '@/stores/commands'
import { commandIcons } from '@/settings/icons'
import { t } from '@/strings'
const extensions = useExtensionsStore(), commands = useCommandsStore(), c = t.commandPalette
const query = ref(''), index = ref(0)
const input = ref<HTMLInputElement | null>(null)
const listId = useId()
const items = computed(() => extensions.availableCommands.filter(command =>
  (command.name + ' ' + command.id + ' ' + extensions.sourceName(command)).toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const activeId = computed(() => items.value[index.value] ? listId + '-' + index.value : undefined)
watch([query, () => items.value.map(command => command.id).join('|')], () => { index.value = 0 })
watch(index, () => void nextTick(() => activeId.value && document.getElementById(activeId.value)?.scrollIntoView({ block: 'nearest' })))
function keydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); event.stopPropagation()
    if (items.value.length) index.value = (index.value + (event.key === 'ArrowDown' ? 1 : -1) + items.value.length) % items.value.length
  } else if (event.key === 'Enter' && event.target === input.value) {
    event.preventDefault(); event.stopPropagation()
    const selected = items.value[index.value]
    if (selected && !event.repeat) void commands.execute(selected.id)
  }
}
</script>
<template>
  <AppDialog :title="c.title" class="command-palette" scroll-body @close="commands.paletteOpen = false">
    <template #heading><div class="palette-heading"><Command :size="19" /><h2>{{ c.title }}</h2></div></template>
    <div data-testid="command-palette" @keydown="keydown">
      <label class="palette-search"><input ref="input" v-model="query" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" :aria-label="c.search" :placeholder="c.placeholder" :aria-controls="listId" :aria-activedescendant="activeId" autofocus autocomplete="off" data-testid="command-search" /><kbd>Esc</kbd></label>
      <p class="palette-caption">{{ c.count(items.length) }}</p>
      <div :id="listId" role="listbox" :aria-label="c.title" class="palette-results" data-testid="command-results">
        <div v-for="(command, i) in items" :key="command.id" class="palette-row" :class="{ active: i === index }" data-testid="palette-command" :data-command="command.id" @pointermove="index = i">
          <button :id="listId + '-' + i" type="button" class="ghost palette-run" role="option" :aria-selected="i === index" :disabled="commands.running.has(command.id) || extensions.busy" data-testid="palette-run" @click="commands.execute(command.id)"><component :is="commandIcons[command.icon]" :size="17" /><span><strong>{{ command.name }}</strong><small>{{ extensions.sourceName(command) }}</small></span><kbd v-if="extensions.displayBinding(command.id)">{{ extensions.displayBinding(command.id) }}</kbd></button>
          <button type="button" class="ghost icon-button palette-pin" :aria-label="extensions.shortcuts.pinned.includes(command.id) ? t.shortcuts.unpin : t.shortcuts.pin" :title="extensions.shortcuts.pinned.includes(command.id) ? t.shortcuts.unpin : t.shortcuts.pin" :aria-pressed="extensions.shortcuts.pinned.includes(command.id)" :disabled="extensions.busy" data-testid="palette-pin" @click="commands.togglePin(command.id)"><Pin :size="14" /></button>
        </div>
        <p v-if="!items.length" class="palette-empty small muted" data-testid="command-empty">{{ extensions.loading ? c.loading : c.empty }}</p>
      </div>
      <p v-if="commands.error || extensions.error" class="palette-error small" role="alert" data-testid="command-error">{{ commands.error || extensions.error }}</p>
    </div>
    <template #footer><div class="palette-footer"><span><kbd>↑ ↓</kbd>{{ c.select }}<kbd>Enter</kbd>{{ c.execute }}</span><button class="ghost" data-testid="palette-manage" @click="commands.manage">{{ c.manage }}</button></div></template>
  </AppDialog>
</template>
<style scoped>
:global(.command-palette.app-dialog) { width:min(var(--command-palette-width), calc(100vw - var(--space-7))); margin:12vh auto auto; }
.palette-heading { display:flex; align-items:center; gap:var(--space-2); color:var(--accent); }
.palette-heading h2 { margin:0; font-size:var(--font-size-text); font-weight:600; color:var(--text-normal); }
.command-palette .palette-search { display:flex; align-items:center; gap:var(--space-3); border-bottom:1px solid var(--border); }
.palette-search:focus-within { border-color:var(--accent); }
.palette-search input { width:100%; min-width:0; border:0; padding:var(--space-3) 0; border-radius:0; background:transparent; font-size:var(--font-size-text); }
kbd { color:var(--text-muted); font:var(--font-size-small) var(--font-mono); white-space:nowrap; }
.command-palette .palette-caption { margin:var(--space-3) 0 var(--space-2); font-size:var(--font-size-small); color:var(--text-muted); }
.palette-results { max-height:45vh; min-height:var(--space-8); overflow:auto; }
.palette-row { display:flex; align-items:center; border-radius:var(--radius-s); }
.palette-row.active { background:var(--accent-soft); }
.palette-run { flex:1; min-width:0; display:flex; align-items:center; gap:var(--space-3); padding:var(--space-2); text-align:left; }
.palette-run > svg { flex:none; color:var(--text-muted); }
.palette-run > span { flex:1; min-width:0; overflow-wrap:anywhere; }
.palette-run strong { display:block; font-size:var(--font-size-ui); font-weight:500; }
.palette-run small { display:block; color:var(--text-muted); font-size:var(--font-size-small); margin-top:var(--space-1); }
.palette-run > kbd { flex:none; }
.palette-pin { flex:none; margin-right:var(--space-1); }
.palette-pin[aria-pressed='true'] { color:var(--accent); }
.palette-row button:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.palette-empty { padding:var(--space-5) var(--space-2); margin:0; text-align:center; }
.palette-error { color:var(--danger); overflow-wrap:anywhere; margin:var(--space-3) 0 0; }
.palette-footer { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); flex-wrap:wrap; color:var(--text-muted); font-size:var(--font-size-small); }
.palette-footer span { display:flex; align-items:center; gap:var(--space-2); }.palette-footer button { font-size:inherit; }
@media (max-width:740px) { .palette-run { gap:var(--space-2); }.palette-run > kbd { font-size:10px; } }
</style>
