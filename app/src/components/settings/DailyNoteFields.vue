<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FileText, FolderInput } from 'lucide-vue-next'
import type { DailyNoteOptions } from '@shared/app-extensions'
import type { DateNotePreview } from '@shared/date-paths'
import { call } from '@/api'
import { t } from '@/strings'
import ContentDirectorySelect from '@/components/ContentDirectorySelect.vue'
import NoteTemplateField from './NoteTemplateField.vue'

const model = defineModel<DailyNoteOptions>({ required: true })
const { extensionId, defaults, active } = defineProps<{ extensionId: string; defaults: DailyNoteOptions; active: boolean }>()
const emit = defineEmits<{ valid: [value: boolean] }>()
const labels = t.extensions, prefix = ref('root')
const preview = ref<DateNotePreview | null>(null), error = ref(''), loading = ref(true), templateValid = ref(false)
const valid = computed(() => !!preview.value && !error.value && !loading.value && templateValid.value)
watch(valid, value => emit('valid', value), { immediate: true })
watch([() => model.value.directory, () => model.value.filename, () => active], ([, , visible], _old, cleanup) => {
  if (!visible) return
  let current = true
  preview.value = null; error.value = ''; loading.value = true
  const directory = model.value.directory?.trim() ?? '', filename = model.value.filename.trim()
  const timer = setTimeout(() => {
    if (!directory) { error.value = labels.noDirectory; loading.value = false; return }
    void call('extensions:previewDateNote', { directory, filename })
      .then(value => { if (current) preview.value = value })
      .catch(failure => { if (current) error.value = (failure as Error).message })
      .finally(() => { if (current) loading.value = false })
  }, 180)
  cleanup(() => { current = false; clearTimeout(timer) })
}, { immediate: true })
</script>
<template>
  <section class="profile-section">
    <h3 class="profile-section-title"><FolderInput :size="16" />{{ labels.saveRules }}</h3>
    <label class="profile-field profile-path">{{ labels.directory }}<input v-model.trim="model.directory" type="text" maxlength="1000" :placeholder="labels.directoryPlaceholder" data-testid="profile-directory" /><small class="muted">{{ labels.directoryHint }}</small></label>
    <details class="directory-picker"><summary class="small"><FolderInput :size="13" />{{ labels.chooseDirectory }}</summary><div class="settings-actions"><ContentDirectorySelect v-model="prefix" data-testid="profile-directory-prefix" /><button type="button" @click="model.directory = prefix === 'root' ? 'content' : prefix">{{ labels.insertDirectory }}</button></div></details>
    <label class="profile-field profile-path">{{ labels.filename }}<input v-model.trim="model.filename" type="text" maxlength="255" data-testid="profile-filename" /><small class="muted">{{ labels.filenameHint }}</small></label>
    <div class="output-preview" data-testid="profile-date-preview" aria-live="polite">
      <strong class="preview-heading"><FileText :size="15" />{{ labels.target }}</strong>
      <code v-if="preview" data-testid="profile-target-path">{{ preview.path }}</code>
      <p v-if="loading" class="small muted">{{ labels.loading }}</p>
      <p v-else-if="error" class="settings-error" data-testid="profile-path-error">{{ error }}</p>
      <dl v-if="preview" class="preview-paths"><dt>{{ labels.targetDirectory }}</dt><dd><code>{{ preview.directory }}</code></dd></dl>
      <p class="small muted">{{ labels.pathHint }}</p>
    </div>
  </section>
  <section class="profile-section">
    <h3 class="profile-section-title"><FileText :size="16" />{{ labels.template }}</h3>
    <NoteTemplateField v-model="model.template" :extension-id :default-template="defaults.template" :active @valid="templateValid = $event" />
  </section>
</template>
