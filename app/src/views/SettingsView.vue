<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { useAppStore } from '@/stores/app'
import { useToastsStore } from '@/stores/toasts'
import { call } from '@/api'
import type { Settings, SettingsInput } from '@shared/types'
import { t } from '@/strings'
import ModelForm from '@/components/ModelForm.vue'
import StorageMaintenance from '@/components/StorageMaintenance.vue'
import AppSelect from '@/components/AppSelect.vue'
import TimePicker from '@/components/TimePicker.vue'
import ExtensionsSettings from '@/components/settings/ExtensionsSettings.vue'
import ShortcutsSettings from '@/components/settings/ShortcutsSettings.vue'
import '@/styles/settings.css'

const app = useAppStore(), toasts = useToastsStore()
const emit = defineEmits<{ history: [] }>()
const page = computed(() => app.settingsSection)
const rebuilding = ref(false), error = ref('')
const hotkey = ref(app.settings?.capture.hotkey ?? '')
const sideWidth = ref(app.settings!.layout.sideWidth), agentWidth = ref(app.settings!.layout.agentWidth)
watch(() => app.settings?.capture.hotkey, (next, previous) => { if (next && hotkey.value === previous) hotkey.value = next })
watch(() => app.settings?.layout.sideWidth, next => { if (next) sideWidth.value = next })
watch(() => app.settings?.layout.agentWidth, next => { if (next) agentWidth.value = next })
async function update(input: SettingsInput): Promise<void> {
  error.value = ''
  try { await app.updateSettings(input) }
  catch (e) { error.value = (e as Error).message }
}
function saveHotkey(): void {
  const value = hotkey.value.trim()
  if (value && value !== app.settings?.capture.hotkey) void update({ capture: { hotkey: value } })
}
async function rebuild(): Promise<void> {
  rebuilding.value = true
  try { const result = await call('vault:rebuildIndex'); toasts.info(t.settings.rebuilt(result.indexed)) }
  catch (e) { toasts.error((e as Error).message) }
  finally { rebuilding.value = false }
}
function openLibrary(): void { useLibraryStore().select({ collection: 'all' }) }
function setTheme(theme: Settings['appearance']['theme']): void { void update({ appearance: { theme } }) }
function setCloseBehavior(closeBehavior: Settings['window']['closeBehavior']): void { void update({ window: { closeBehavior } }) }
</script>
<template>
  <div class="settings-page" data-testid="settings">
    <header v-show="page !== 'extensions' && page !== 'shortcuts'" class="settings-heading"><div><h2>{{ t.settings.navigation[page] }}</h2><p>{{ t.settings.descriptions[page] }}</p></div></header>
    <div v-show="page === 'vault'" data-testid="settings-page-vault">
      <section class="settings-card"><h3>{{ t.settings.currentVault }}</h3><div class="settings-row"><span>{{ t.settings.vaultPath }}</span><code class="selectable" data-testid="settings-vault-path">{{ app.vault.path }}</code></div><div class="settings-row"><span>{{ t.directory.title }}</span><button class="ghost" data-testid="settings-manage-folders" @click="openLibrary">{{ t.settings.openLibrary }}</button></div><div class="settings-row"><span>{{ t.extensions.title }}</span><button class="ghost" @click="app.settingsSection = 'extensions'">{{ t.extensions.configure }}</button></div></section>
      <section class="settings-card"><details data-testid="settings-backup"><summary>{{ t.settings.backupTitle }}</summary><p class="small muted">{{ t.settings.backupHint }}</p></details></section>
    </div>
    <div v-show="page === 'appearance'" data-testid="settings-page-appearance">
      <section class="settings-card"><h3>{{ t.settings.groupAppearance }}</h3>
        <div class="settings-row"><span>{{ t.settings.theme }}</span><AppSelect :model-value="app.settings?.appearance.theme ?? 'system'" :label="t.settings.theme" :options="[{ value: 'system', label: t.settings.themeSystem }, { value: 'dark', label: t.settings.themeDark }, { value: 'light', label: t.settings.themeLight }]" data-testid="settings-theme" @update:model-value="setTheme" /></div>
        <div class="settings-row"><span>{{ t.settings.closeBehavior }}</span><AppSelect :model-value="app.settings?.window.closeBehavior ?? 'tray'" :label="t.settings.closeBehavior" :options="[{ value: 'tray', label: t.settings.closeToTray }, { value: 'quit', label: t.settings.closeQuit }]" data-testid="settings-close-behavior" @update:model-value="setCloseBehavior" /></div>
        <label class="settings-row"><span>{{ t.settings.sideWidth }}</span><div class="width-input"><input v-model.number="sideWidth" type="range" min="200" max="360" data-testid="settings-side-width" @change="update({ layout: { sideWidth } })" /><output>{{ sideWidth }}px</output></div></label>
        <label class="settings-row"><span>{{ t.settings.agentWidth }}</span><div class="width-input"><input v-model.number="agentWidth" type="range" min="348" max="560" data-testid="settings-agent-width" @change="update({ layout: { agentWidth } })" /><output>{{ agentWidth }}px</output></div></label>
        <div class="settings-row"><span>{{ t.settings.layoutVisibility }}</span><div class="settings-actions"><label class="check-label"><input type="checkbox" :checked="!app.settings!.layout.sideCollapsed" data-testid="settings-show-side" @change="update({ layout: { sideCollapsed: !($event.target as HTMLInputElement).checked } })" />{{ t.settings.showSide }}</label><label class="check-label"><input type="checkbox" :checked="!app.settings!.layout.agentCollapsed" data-testid="settings-show-agent" @change="update({ layout: { agentCollapsed: !($event.target as HTMLInputElement).checked } })" />{{ t.settings.showAgent }}</label></div></div>
      </section>
    </div>
    <section v-show="page === 'model'" class="settings-card" data-testid="settings-page-model"><h3>{{ t.settings.groupModel }}</h3><ModelForm /></section>
    <div v-show="page === 'capture'" data-testid="settings-page-capture">
      <section class="settings-card"><h3>{{ t.settings.groupCapture }}</h3><label class="settings-row"><span>{{ t.settings.hotkey }}</span><input v-model="hotkey" type="text" data-testid="settings-hotkey" :placeholder="t.settings.hotkeyHint" @change="saveHotkey" @keydown.enter="saveHotkey" /></label><div class="settings-row"><span>{{ t.settings.launchAtLogin }}</span><div class="settings-actions"><input type="checkbox" :checked="app.settings?.capture.launchAtLogin" :aria-label="t.settings.launchAtLogin" data-testid="settings-launch" @change="update({ capture: { launchAtLogin: ($event.target as HTMLInputElement).checked } })" /><span class="small muted">{{ t.settings.launchHint }}</span></div></div></section>
      <section class="settings-card"><h3>{{ t.settings.groupClassify }}</h3><label class="settings-row"><span>{{ t.settings.classifyEnabled }}</span><input type="checkbox" :checked="app.settings?.classify.enabled" data-testid="settings-classify-enabled" @change="update({ classify: { enabled: ($event.target as HTMLInputElement).checked } })" /></label></section>
      <section class="settings-card"><h3>{{ t.settings.groupDaily }}</h3><label class="settings-row"><span>{{ t.settings.dailyEnabled }}</span><input type="checkbox" :checked="app.settings?.daily.enabled" data-testid="settings-daily-enabled" @change="update({ daily: { enabled: ($event.target as HTMLInputElement).checked } })" /></label><div class="settings-row"><span>{{ t.settings.dailyTime }}</span><TimePicker :model-value="app.settings?.daily.time ?? '21:30'" :label="t.settings.dailyTime" testid="settings-daily-time" :clearable="false" @update:model-value="update({ daily: { time: $event } })" /></div></section>
    </div>
    <ShortcutsSettings v-show="page === 'shortcuts'" :active="app.showSettings && page === 'shortcuts'" />
    <ExtensionsSettings v-show="page === 'extensions'" :active="app.showSettings && page === 'extensions'" />
    <div v-show="page === 'storage'" data-testid="settings-page-storage">
      <section class="settings-card"><h3>{{ t.settings.rebuildIndex }}</h3><div class="settings-actions"><button :disabled="rebuilding" data-testid="settings-rebuild" @click="rebuild">{{ rebuilding ? t.settings.rebuilding : t.settings.rebuildIndex }}</button><span class="small muted">{{ t.settings.rebuildHint }}</span></div></section>
      <section class="settings-card"><h3>{{ t.settings.groupJobs }}</h3><div class="settings-actions"><button data-testid="settings-jobs" @click="app.showJobs = true">{{ t.settings.viewJobs }}</button><span class="small muted">{{ t.jobs.processing(app.jobs.running + app.jobs.queued) }}<template v-if="app.jobs.failed">，{{ t.jobs.failed(app.jobs.failed) }}</template></span></div></section>
      <StorageMaintenance class="settings-card" :active="app.showSettings && page === 'storage'" @history="emit('history')" />
    </div>
    <section v-show="page === 'about'" class="settings-card" data-testid="settings-page-about"><div class="settings-row"><span>{{ t.settings.version }}</span><span data-testid="settings-version">{{ app.info?.version }}</span></div><details><summary>{{ t.settings.backupTitle }}</summary><p class="small muted">{{ t.settings.backupHint }}</p></details></section>
    <p v-if="error" class="settings-error" role="alert" data-testid="settings-error">{{ error }}</p>
  </div>
</template>
<style scoped>
.settings-row > input[type='checkbox'] { justify-self:start; }
.settings-row > input[type='text'] { max-width:300px; }
.check-label, .width-input { display:flex; align-items:center; gap:var(--space-2); }
.width-input input { width:100%; max-width:280px; accent-color:var(--accent); }
.width-input output { min-width:50px; font-size:var(--font-size-small); color:var(--text-muted); }
details { margin-top:var(--space-3); } summary { cursor:pointer; } details p { line-height:var(--line-height); }
</style>
