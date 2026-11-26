<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FileText, FolderInput } from 'lucide-vue-next'
import type { WorkReportMonthPreview, WorkReportOptions } from '@shared/work-reports'
import { call } from '@/api'
import { t } from '@/strings'
import ContentDirectorySelect from '@/components/ContentDirectorySelect.vue'
import NoteTemplateField from './NoteTemplateField.vue'

const model = defineModel<WorkReportOptions>({ required: true })
const { extensionId, defaults, active } = defineProps<{ extensionId: string; defaults: WorkReportOptions; active: boolean }>()
const emit = defineEmits<{ valid: [value: boolean] }>()
const labels = t.extensions, workLabels = t.workDiary, prefix = ref('root')
const preview = ref<WorkReportMonthPreview | null>(null), error = ref(''), loading = ref(true)
const templateValid = ref(false), okrValid = ref(false)
const root = computed({ get: () => model.value.root ?? '', set: value => { model.value.root = value.trim() || null } })
const worklog = computed({ get: () => model.value.worklogDirectory ?? '', set: value => { model.value.worklogDirectory = value.trim() || null } })
const initializeOkr = computed({
  get: () => model.value.okrTemplate !== null,
  set: value => { model.value.okrTemplate = value ? JSON.parse(JSON.stringify(defaults.okrTemplate ?? { kind: 'none' })) : null },
})
const valid = computed(() => !!preview.value && !error.value && !loading.value && templateValid.value && (!initializeOkr.value || okrValid.value))
watch(valid, value => emit('valid', value), { immediate: true })
watch([root, () => model.value.draftDirectory, () => model.value.reportDirectory, worklog, () => model.value.filename, () => active], (_next, _old, cleanup) => {
  if (!active) return
  let current = true
  preview.value = null; error.value = ''; loading.value = true
  const options: WorkReportOptions = { root: model.value.root, draftDirectory: model.value.draftDirectory, reportDirectory: model.value.reportDirectory,
    worklogDirectory: model.value.worklogDirectory, filename: model.value.filename, template: { kind: 'none' }, okrTemplate: null }
  const timer = setTimeout(() => {
    if (!options.root) { error.value = workLabels.noRoot; loading.value = false; return }
    void call('extensions:previewWorkReport', options)
      .then(value => { if (current) preview.value = value })
      .catch(failure => { if (current) error.value = (failure as Error).message })
      .finally(() => { if (current) loading.value = false })
  }, 180)
  cleanup(() => { current = false; clearTimeout(timer) })
}, { immediate: true })
</script>
<template>
  <section class="profile-section" data-testid="work-diary-fields">
    <h3 class="profile-section-title"><FolderInput :size="16" />{{ workLabels.paths }}</h3>
    <label class="profile-field profile-path">{{ workLabels.root }}<input v-model="root" type="text" maxlength="1000" :placeholder="workLabels.rootPlaceholder" data-testid="work-root" /><small class="muted">{{ workLabels.rootHint }}</small></label>
    <details class="directory-picker"><summary class="small"><FolderInput :size="13" />{{ labels.chooseDirectory }}</summary><div class="settings-actions"><ContentDirectorySelect v-model="prefix" data-testid="work-root-prefix" /><button type="button" @click="root = prefix === 'root' ? 'content' : prefix">{{ labels.insertDirectory }}</button></div></details>
    <div class="profile-field-grid">
      <label class="profile-field profile-path">{{ workLabels.draftDirectory }}<input v-model.trim="model.draftDirectory" type="text" maxlength="1000" data-testid="work-draft-directory" /></label>
      <label class="profile-field profile-path">{{ workLabels.reportDirectory }}<input v-model.trim="model.reportDirectory" type="text" maxlength="1000" data-testid="work-report-directory" /></label>
    </div>
    <p class="profile-hint muted">{{ workLabels.monthDirectoryHint }}</p>
    <label class="profile-field profile-path">{{ workLabels.filename }}<input v-model.trim="model.filename" type="text" maxlength="255" data-testid="profile-filename" /><small class="muted">{{ workLabels.filenameHint }}</small></label>
    <label class="profile-field profile-path">{{ workLabels.worklogDirectory }}<input v-model="worklog" type="text" maxlength="1000" :placeholder="workLabels.worklogPlaceholder" data-testid="work-log-directory" /><small class="muted">{{ workLabels.worklogHint }}</small></label>
    <div class="output-preview" data-testid="work-month-preview" aria-live="polite">
      <strong class="preview-heading"><FileText :size="15" />{{ labels.target }}</strong>
      <code v-if="preview" data-testid="profile-target-path">{{ preview.dailyDraft.path }}</code>
      <p v-if="loading" class="small muted">{{ labels.loading }}</p>
      <p v-else-if="error" class="settings-error" data-testid="profile-path-error">{{ error }}</p>
      <template v-if="preview">
        <dl class="preview-paths">
          <dt>{{ workLabels.draftMonth }}</dt><dd><code data-testid="work-draft-month">{{ preview.draftDirectory }}</code></dd>
          <dt>{{ workLabels.reportMonth }}</dt><dd><code data-testid="work-report-month">{{ preview.reportDirectory }}</code></dd>
          <template v-if="initializeOkr"><dt>{{ workLabels.draftOkr }}</dt><dd><code data-testid="work-okr-path">{{ preview.draftOkrPath }}</code></dd></template>
        </dl>
        <details class="month-details"><summary class="small muted">{{ workLabels.directories }}</summary><ul class="month-directories small selectable"><li v-for="directory in preview.directories" :key="directory"><code>{{ directory }}</code></li></ul><p class="small muted">{{ workLabels.initializeHint }}</p></details>
      </template>
      <p class="small muted">{{ labels.pathHint }}</p>
    </div>
  </section>
  <section class="profile-section">
    <h3 class="profile-section-title"><FileText :size="16" />{{ workLabels.templates }}</h3>
    <NoteTemplateField v-model="model.template" :extension-id :default-template="defaults.template" :active :label="workLabels.dailyTemplate" @valid="templateValid = $event" />
    <div class="profile-option">
      <label class="pin-label"><input v-model="initializeOkr" type="checkbox" data-testid="work-initialize-okr" />{{ workLabels.initializeOkr }}</label>
      <NoteTemplateField v-if="model.okrTemplate" v-model="model.okrTemplate" :extension-id :default-template="defaults.okrTemplate ?? { kind: 'none' }" :active :label="workLabels.okrTemplate" prefix="okr" @valid="okrValid = $event" />
    </div>
  </section>
</template>
<style scoped>
.month-directories { padding-left:var(--space-4); margin:var(--space-3) 0 0; }
.month-directories li { margin-top:var(--space-1); }
.month-details { margin-top:var(--space-4); }
summary { cursor:pointer; width:fit-content; }
</style>
