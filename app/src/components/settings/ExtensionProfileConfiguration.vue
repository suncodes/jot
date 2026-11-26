<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ChevronRight, Keyboard, SlidersHorizontal } from 'lucide-vue-next'
import type { AppExtensionOptions, AppExtensionProfile, ManagedAppExtension } from '@shared/app-extensions'
import { extensionCommandId } from '@shared/commands'
import { call } from '@/api'
import { useAppStore } from '@/stores/app'
import { useExtensionsStore } from '@/stores/extensions'
import { useToastsStore } from '@/stores/toasts'
import { shortcutProblem } from '@/settings/shortcuts'
import { t } from '@/strings'
import AppDialog from '@/components/AppDialog.vue'
import AppSelect from '@/components/AppSelect.vue'
import ShortcutRecorder from './ShortcutRecorder.vue'
import DailyNoteFields from './DailyNoteFields.vue'
import WorkDiaryFields from './WorkDiaryFields.vue'

const { pkg, profile, active } = defineProps<{ pkg: ManagedAppExtension; profile: AppExtensionProfile | null; active: boolean }>()
const emit = defineEmits<{ close: [] }>()
const app = useAppStore(), extensions = useExtensionsStore(), toasts = useToastsStore(), labels = t.extensions
const initialCommand = pkg.manifest!.commands.find(command => command.id === profile?.commandId) ?? pkg.manifest!.commands[0]!
const commandId = ref(profile?.commandId ?? initialCommand.id)
const command = computed(() => pkg.manifest!.commands.find(command => command.id === commandId.value)!)
const id = computed(() => profile ? extensionCommandId(pkg.id, profile.id, profile.commandId) : '')
const form = reactive({
  name: profile?.name ?? initialCommand.name, options: JSON.parse(JSON.stringify(profile?.options ?? initialCommand.defaults)) as AppExtensionOptions,
  pinned: !!id.value && extensions.shortcuts.pinned.includes(id.value), hotkey: id.value ? extensions.binding(id.value) : '',
})
const baseline = JSON.stringify(form)
const dirty = computed(() => JSON.stringify(form) !== baseline || commandId.value !== initialCommand.id)
const fieldsValid = ref(false), error = ref(''), saving = ref(false), discard = ref(false)
let leave: (() => void) | undefined
watch(() => active, value => { if (!value) { discard.value = false; leave = undefined } })
const keyError = computed(() => shortcutProblem(form.hotkey, id.value, extensions.shortcuts, app.settings?.capture.hotkey ?? ''))
const invalid = computed(() => !form.name.trim() || !fieldsValid.value || !!keyError.value)
function setCommand(value: string): void {
  commandId.value = value; fieldsValid.value = false
  form.name = command.value.name
  form.options = JSON.parse(JSON.stringify(command.value.defaults)) as AppExtensionOptions
}
function close(after: () => void = () => emit('close')): void {
  if (saving.value) return
  if (dirty.value) { leave = after; discard.value = true }
  else after()
}
async function save(): Promise<void> {
  if (saving.value || invalid.value) return
  saving.value = true; error.value = ''
  try {
    await call('extensions:saveProfile', { id: pkg.id,
      profile: { ...(profile ? { id: profile.id } : {}), commandId: commandId.value, name: form.name.trim(), options: JSON.parse(JSON.stringify(form.options)) as AppExtensionOptions },
      shortcut: { pinned: form.pinned, hotkey: form.hotkey || null },
    })
    await extensions.refresh()
    toasts.info(labels.saved); emit('close')
  } catch (failure) { error.value = (failure as Error).message }
  finally { saving.value = false }
}
defineExpose({ close })
</script>
<template>
  <div data-testid="extension-profile-editor">
    <nav class="settings-breadcrumb"><button type="button" class="ghost" @click="close()">{{ labels.title }}</button><ChevronRight :size="13" /><span>{{ pkg.manifest?.name }}</span><ChevronRight :size="13" /><span>{{ profile ? labels.editProfile : labels.newProfile }}</span></nav>
    <header class="settings-heading"><div><h2>{{ profile ? labels.editProfile : labels.newProfile }}</h2><p>{{ command.action === 'work-diary' ? t.workDiary.profileHint : labels.profileHint }}</p></div></header>
    <form class="profile-form" data-testid="extension-profile-form" @submit.prevent="save">
      <fieldset :disabled="saving || extensions.busy">
        <section class="profile-section">
          <h3 class="profile-section-title"><SlidersHorizontal :size="16" />{{ labels.profileInfo }}</h3>
          <label class="profile-field">{{ labels.name }}<input v-model="form.name" type="text" maxlength="120" required data-testid="profile-name" /></label>
          <label v-if="!profile && pkg.manifest!.commands.length > 1" class="profile-field">{{ labels.selectCommand }}<AppSelect :model-value="commandId" :label="labels.selectCommand" :options="pkg.manifest!.commands.map(command => ({ value: command.id, label: command.name }))" @update:model-value="setCommand" /></label>
        </section>
        <WorkDiaryFields v-if="'root' in form.options && command.action === 'work-diary'" :key="commandId" :model-value="form.options" :extension-id="pkg.id" :defaults="command.defaults" :active @update:model-value="form.options = $event" @valid="fieldsValid = $event" />
        <DailyNoteFields v-else-if="'directory' in form.options && command.action === 'daily-note'" :key="commandId" :model-value="form.options" :extension-id="pkg.id" :defaults="command.defaults" :active @update:model-value="form.options = $event" @valid="fieldsValid = $event" />
        <section class="profile-section"><h3 class="profile-section-title"><Keyboard :size="16" />{{ labels.entry }}</h3><label class="pin-label"><input v-model="form.pinned" type="checkbox" data-testid="profile-pinned" />{{ labels.pin }}</label><div class="profile-field"><span>{{ t.shortcuts.hotkey }}</span><ShortcutRecorder v-model="form.hotkey" /></div><p v-if="keyError" class="settings-error" role="alert" data-testid="profile-hotkey-error">{{ keyError }}</p></section>
      </fieldset>
      <p v-if="error" class="settings-error" role="alert" data-testid="profile-save-error">{{ error }}</p>
      <footer class="profile-footer"><span class="small muted">{{ labels.keepNotes }}</span><div class="settings-actions"><button type="button" :disabled="saving" @click="close()">{{ t.common.cancel }}</button><button type="submit" class="primary" :disabled="invalid || saving || extensions.busy" data-testid="profile-save">{{ t.settings.save }}</button></div></footer>
    </form>
    <AppDialog v-if="discard" :title="labels.discardTitle" compact @close="discard = false; leave = undefined"><p>{{ labels.discardHint }}</p><div class="dialog-actions"><button @click="discard = false; leave = undefined">{{ labels.keepEditing }}</button><button class="primary" data-testid="profile-discard" @click="discard = false; leave?.(); leave = undefined">{{ labels.discard }}</button></div></AppDialog>
  </div>
</template>
<style scoped>
fieldset { border:0; padding:0; margin:0; min-width:0; display:grid; gap:var(--space-4); }
:deep(.profile-section) { min-width:0; padding:var(--space-5); border:1px solid var(--border); border-radius:var(--radius-m); }
:deep(.profile-section-title) { display:flex; align-items:center; gap:var(--space-2); margin:0 0 var(--space-5); }
:deep(.profile-section-title > svg) { flex:none; color:var(--accent); }
:deep(.profile-field) { display:grid; gap:var(--space-2); margin:0 0 var(--space-4); font-size:var(--font-size-ui); font-weight:500; line-height:1.6; min-width:0; }
:deep(.profile-field:last-child) { margin-bottom:0; }
:deep(.profile-field > input) { width:100%; min-width:0; padding:var(--space-2) var(--space-3); font-weight:400; background:var(--bg-primary); }
:deep(.profile-field > input:focus) { outline:2px solid var(--accent-soft); outline-offset:1px; border-color:var(--accent); }
:deep(.profile-field > small), :deep(.profile-hint) { font-size:var(--font-size-small); font-weight:400; line-height:1.7; }
:deep(.profile-path > input) { font-family:var(--font-mono); font-size:var(--font-size-small); }
:deep(.profile-field-grid) { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-4); margin-bottom:var(--space-2); }
:deep(.profile-field-grid > .profile-field) { margin-bottom:0; }
:deep(.profile-hint) { margin:0 0 var(--space-4); }
:deep(.directory-picker) { margin:0 0 var(--space-5); }
:deep(.directory-picker summary) { display:flex; align-items:center; gap:var(--space-1); cursor:pointer; width:fit-content; color:var(--accent); }
:deep(.directory-picker[open] > div) { margin-top:var(--space-3); }
:deep(.output-preview) { background:var(--accent-soft); border:1px solid color-mix(in srgb,var(--accent) 22%,var(--border)); border-radius:var(--radius-m); padding:var(--space-4); margin-top:var(--space-5); overflow-wrap:anywhere; }
:deep(.preview-heading) { display:flex; align-items:center; gap:var(--space-2); color:var(--accent); font-size:var(--font-size-small); }
:deep(.preview-heading svg) { flex:none; }
:deep(.output-preview > code) { display:block; margin-top:var(--space-3); color:var(--text-normal); font-weight:500; line-height:1.8; user-select:text; }
:deep(.output-preview p) { margin:var(--space-3) 0 0; line-height:1.7; }
:deep(.preview-paths) { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--space-2) var(--space-4); margin:var(--space-4) 0 0; padding-top:var(--space-3); border-top:1px solid color-mix(in srgb,var(--accent) 15%,var(--border)); font-size:var(--font-size-small); line-height:1.7; }
:deep(.preview-paths dt) { color:var(--text-muted); }
:deep(.preview-paths dd) { margin:0; min-width:0; }
:deep(.profile-option) { border-top:1px solid var(--border); padding-top:var(--space-4); margin-top:var(--space-5); }
:deep(.pin-label) { display:flex; align-items:center; gap:var(--space-2); margin:0 0 var(--space-4); font-size:var(--font-size-ui); line-height:1.6; cursor:pointer; }
:deep(.pin-label > input) { flex:none; }
.profile-footer { display:flex; justify-content:space-between; gap:var(--space-3); flex-wrap:wrap; align-items:center; padding:var(--space-5) 0 0; }
@container content (max-width:760px) {
  :deep(.profile-field-grid) { grid-template-columns:minmax(0,1fr); }
}
@container content (max-width:600px) {
  :deep(.profile-section) { padding:var(--space-4); }
  :deep(.preview-paths) { grid-template-columns:minmax(0,1fr); gap:var(--space-1); }
  :deep(.preview-paths dd + dt) { margin-top:var(--space-2); }
  .profile-footer > .settings-actions { margin-left:auto; }
}
</style>
