<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Pin, Play, Search, X } from 'lucide-vue-next'
import type { AppCommand } from '@shared/commands'
import type { ShortcutConfiguration } from '@shared/app-extensions'
import { useCommandsStore } from '@/stores/commands'
import { useAppStore } from '@/stores/app'
import { useExtensionsStore } from '@/stores/extensions'
import { useToastsStore } from '@/stores/toasts'
import { shortcutProblem } from '@/settings/shortcuts'
import { t } from '@/strings'
import { commandIcons } from '@/settings/icons'
import AppDialog from '@/components/AppDialog.vue'
import ShortcutRecorder from './ShortcutRecorder.vue'
const { active } = defineProps<{ active: boolean }>()
const commands = useCommandsStore(), extensions = useExtensionsStore(), app = useAppStore(), toasts = useToastsStore(), c = t.shortcuts
const query = ref(''), error = ref(''), selected = ref<AppCommand | null>(null), hotkey = ref('')
const filtered = computed(() => extensions.allCommands.filter(command => (command.name + ' ' + extensions.sourceName(command)).toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const pinned = computed(() => extensions.shortcuts.pinned.map(id => extensions.allCommands.find(command => command.id === id)!).filter(Boolean))
const keyError = computed(() => selected.value ? shortcutProblem(hotkey.value, selected.value.id, extensions.shortcuts, app.settings?.capture.hotkey ?? '') : '')
watch(() => active, value => { if (!value) selected.value = null; else void extensions.refresh() })
async function save(next: ShortcutConfiguration): Promise<boolean> {
  if (extensions.busy) return false
  extensions.busy = true; error.value = ''
  try { await extensions.saveShortcuts(next); return true }
  catch (e) { error.value = (e as Error).message; return false }
  finally { extensions.busy = false }
}
function snapshot(): ShortcutConfiguration { return JSON.parse(JSON.stringify(extensions.shortcuts)) as ShortcutConfiguration }
async function pin(command: AppCommand): Promise<void> {
  const next = snapshot()
  next.pinned = next.pinned.includes(command.id) ? next.pinned.filter(id => id !== command.id) : [...next.pinned, command.id]
  await save(next)
}
async function move(index: number, offset: number): Promise<void> {
  const next = snapshot(), destination = index + offset
  if (destination < 0 || destination >= next.pinned.length) return
  ;[next.pinned[index], next.pinned[destination]] = [next.pinned[destination]!, next.pinned[index]!]
  await save(next)
}
function record(command: AppCommand): void { selected.value = command; hotkey.value = extensions.binding(command.id); error.value = '' }
async function saveBinding(): Promise<void> {
  if (!selected.value || keyError.value) return
  const next = snapshot()
  next.bindings = next.bindings.filter(binding => binding.commandId !== selected.value!.id)
  if (hotkey.value) next.bindings.push({ commandId: selected.value.id, hotkey: hotkey.value })
  if (await save(next)) { selected.value = null; toasts.info(c.saved) }
}
</script>
<template>
  <div data-testid="settings-shortcuts">
    <header class="settings-heading"><div><h2>{{ c.title }}</h2><p>{{ t.settings.descriptions.shortcuts }}</p></div><button class="ghost" data-testid="shortcuts-open-palette" @click="commands.execute('core.command-palette')">{{ t.commandPalette.title }}<kbd>Ctrl+Shift+P</kbd></button></header>
    <section class="settings-section"><h3>{{ c.pinned }}</h3><p class="small muted">{{ c.pinHint }}</p>
      <div v-for="(command, index) in pinned" :key="command.id" class="settings-list-row" data-testid="shortcut-pinned" :data-command="command.id">
        <component :is="commandIcons[command.icon]" :size="17" class="command-icon" /><div class="settings-list-copy"><strong>{{ command.name }}</strong><p>{{ extensions.sourceName(command) }}<template v-if="!command.availability.available"> · {{ command.availability.reason }}</template></p></div>
        <div class="settings-actions"><button class="ghost icon-button" :disabled="extensions.busy || index === 0" :aria-label="c.up" :title="c.up" data-testid="shortcut-up" @click="move(index, -1)"><ArrowUp :size="15" /></button><button class="ghost icon-button" :disabled="extensions.busy || index === pinned.length - 1" :aria-label="c.down" :title="c.down" data-testid="shortcut-down" @click="move(index, 1)"><ArrowDown :size="15" /></button><button class="ghost icon-button" :disabled="extensions.busy" :aria-label="c.unpin" :title="c.unpin" data-testid="shortcut-unpin" @click="pin(command)"><X :size="15" /></button></div>
      </div><p v-if="!pinned.length" class="small muted">{{ c.empty }}</p>
    </section>
    <section class="settings-section"><h3>{{ c.all }}</h3><label class="settings-search"><Search :size="15" /><input v-model="query" type="text" :aria-label="c.search" :placeholder="c.search" data-testid="shortcuts-search" /></label>
      <div v-for="command in filtered" :key="command.id" class="settings-list-row" data-testid="shortcut-command" :data-command="command.id">
        <component :is="commandIcons[command.icon]" :size="17" class="command-icon" /><div class="settings-list-copy"><strong>{{ command.name }}</strong><p>{{ extensions.sourceName(command) }}<template v-if="!command.availability.available"> · {{ command.availability.reason }}</template></p></div>
        <div class="settings-actions"><button class="ghost small" :disabled="extensions.busy" data-testid="shortcut-binding" @click="record(command)"><kbd v-if="extensions.binding(command.id)">{{ extensions.binding(command.id) }}</kbd><span v-else>{{ c.record }}</span></button><button class="ghost icon-button" :disabled="extensions.busy" :aria-label="extensions.shortcuts.pinned.includes(command.id) ? c.unpin : c.pin" :title="extensions.shortcuts.pinned.includes(command.id) ? c.unpin : c.pin" :aria-pressed="extensions.shortcuts.pinned.includes(command.id)" data-testid="shortcut-pin" @click="pin(command)"><Pin :size="15" /></button><button class="ghost icon-button" :disabled="extensions.busy || commands.running.has(command.id) || !command.availability.available" :aria-label="c.execute" :title="c.execute" data-testid="shortcut-execute" @click="commands.execute(command.id)"><Play :size="15" /></button></div>
      </div><p v-if="!filtered.length" class="settings-empty">{{ c.noResults }}</p>
    </section>
    <p v-if="error" class="settings-error" role="alert" data-testid="shortcuts-error">{{ error }}</p><p v-if="extensions.error" class="settings-error" role="alert">{{ extensions.error }}</p>
    <AppDialog v-if="selected" :title="selected.name + ' · ' + c.hotkey" :busy="extensions.busy" compact @close="selected = null"><form @submit.prevent="saveBinding"><ShortcutRecorder v-model="hotkey" /><p v-if="keyError || error" class="settings-error" role="alert" data-testid="shortcuts-binding-error">{{ keyError || error }}</p><div class="dialog-actions"><button type="button" :disabled="extensions.busy" @click="selected = null">{{ t.common.cancel }}</button><button class="primary" :disabled="extensions.busy || !!keyError" data-testid="shortcut-binding-save">{{ t.settings.save }}</button></div></form></AppDialog>
  </div>
</template>
<style scoped>
.command-icon { color:var(--text-muted); flex:none; }
kbd { font-family:var(--font-mono); font-size:var(--font-size-small); }
[aria-pressed='true'] { color:var(--accent); background:var(--accent-soft); }
</style>
