<script setup lang="ts">
import { FolderClock, RefreshCw, Tags } from 'lucide-vue-next'
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import type { ClassificationPatch, Doc, TermInfo, TermKind } from '@shared/types'
import { ApiError, call, on } from '@/api'
import ChipsInput from '@/components/ChipsInput.vue'
import ContentLocation from './ContentLocation.vue'
import DatePicker from './DatePicker.vue'
import LogTimeEditor from './LogTimeEditor.vue'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'

// 属性按钮控制展开；面板只负责分类、位置与时间的编辑。
const { doc, canReclassify = true } = defineProps<{ doc: Doc; canReclassify?: boolean }>()
const emit = defineEmits<{
  updated: [classification: Doc['classification']]
  'log-time-updated': []
}>()
const tabs = useTabsStore()
const toasts = useToastsStore()

const open = defineModel<boolean>('open', { required: true })
const occurred = ref(doc.occurredAt ?? '')
const timeBusy = ref(false)
watch(() => doc.occurredAt, value => { occurred.value = value ?? '' })
const ownerPath = computed(() => doc.type === 'source-summary' && doc.sourcePath && !doc.sourceMissing ? doc.sourcePath : doc.path)
const terms = ref<Record<TermKind, TermInfo[]>>({ tag: [], person: [], place: [] })
const placeListId = useId()
const formId = useId()
const classification = computed(() => doc.classification)
const placeDraft = ref(classification.value.place ?? '')
watch(() => classification.value.place, value => { placeDraft.value = value ?? '' })

async function loadOptions(): Promise<void> {
  if (!open.value) return
  try {
    const [tag, person, place] = await Promise.all([
      call('taxonomy:terms', { kind: 'tag' }),
      call('taxonomy:terms', { kind: 'person' }),
      call('taxonomy:terms', { kind: 'place' }),
    ])
    terms.value = { tag, person, place }
  } catch (e) { toasts.error((e as Error).message) }
}
watch(open, () => void loadOptions(), { immediate: true })
const stopTerms = on('taxonomy:changed', () => void loadOptions())
onUnmounted(stopTerms)

// 在“待处理”里点“修改”时自动展开属性面板。
watch(() => tabs.editProps, (p) => {
  if (p === doc.path) {
    open.value = true
    tabs.editProps = null
  }
}, { immediate: true })

async function save(patch: ClassificationPatch): Promise<void> {
  if (doc.sourceMissing) return
  try {
    const meta = await call('doc:setClassification', { ref: { path: ownerPath.value }, patch })
    emit('updated', meta.classification)
  } catch (e) {
    toasts.error(e instanceof ApiError ? e.message : String(e))
  }
}

function savePlace(): void {
  const value = placeDraft.value.trim()
  placeDraft.value = value
  if (value !== (classification.value.place ?? '')) void save({ place: value || null })
}

async function saveTime(value: string): Promise<void> {
  timeBusy.value = true
  try {
    await call('doc:setOccurredAt', { ref: { path: ownerPath.value }, occurredAt: value || null })
    occurred.value = value
  } catch (e) {
    toasts.error((e as Error).message)
    occurred.value = doc.occurredAt ?? ''
  } finally {
    timeBusy.value = false
  }
}

async function reclassify(): Promise<void> {
  try {
    await call('classify:rerun', { ref: { path: ownerPath.value } })
    toasts.info(t.props.reclassifyQueued)
  } catch (e) { toasts.error((e as Error).message) }
}
</script>

<template>
  <div v-if="open" class="props small" data-testid="props">
    <fieldset :id="formId" class="form" :aria-label="t.props.title" :disabled="doc.sourceMissing" data-testid="props-form">
      <div class="property-groups">
        <section class="property-group" :aria-label="t.props.classification">
          <h3 class="group-heading"><Tags :size="15" aria-hidden="true" />{{ t.props.classification }}</h3>
          <div class="field">
            <label class="field-label" :for="formId + '-tags'">{{ t.props.tags }}</label>
            <ChipsInput :input-id="formId + '-tags'" :model-value="classification.tags" :options="terms.tag.map(term => term.name)" :placeholder="t.props.addTag" testid="props-tags" @update:model-value="save({ tags: $event })" />
          </div>
          <div class="field">
            <label class="field-label" :for="formId + '-people'">{{ t.props.people }}</label>
            <ChipsInput :input-id="formId + '-people'" :model-value="classification.people" :options="terms.person.map(term => term.name)" :placeholder="t.props.addPerson" testid="props-people" @update:model-value="save({ people: $event })" />
          </div>
          <div class="field">
            <label class="field-label" :for="formId + '-place'">{{ t.props.place }}</label>
            <input :id="formId + '-place'" v-model="placeDraft" class="place-input" type="text" :list="placeListId" :placeholder="t.props.addPlace" data-testid="props-place-input" @change="savePlace" />
            <datalist :id="placeListId"><option v-for="term in terms.place" :key="term.name" :value="term.name" /></datalist>
          </div>
        </section>

        <section class="property-group" :aria-label="t.props.locationAndTime">
          <h3 class="group-heading"><FolderClock :size="15" aria-hidden="true" />{{ t.props.locationAndTime }}</h3>
          <div class="field">
            <span class="field-label">{{ t.directory.position }}</span>
            <ContentLocation :doc />
          </div>
          <div v-if="doc.type === 'log'" class="field field--top">
            <span class="field-label">{{ t.library.happened }}</span>
            <LogTimeEditor :doc @updated="emit('log-time-updated')" />
          </div>
          <div v-else-if="['note', 'source', 'record'].includes(doc.role ?? '')" class="field field--top">
            <label class="field-label" :for="formId + '-date'">{{ t.directory.occurredAt }}</label>
            <div class="field-control" :inert="timeBusy">
              <DatePicker :id="formId + '-date'" :model-value="occurred" :label="t.directory.occurredAt" data-testid="props-occurred" @update:model-value="saveTime" />
              <small class="field-hint">{{ t.directory.timeHint }}</small>
            </div>
          </div>
        </section>
      </div>

      <div v-if="canReclassify && !doc.sourceMissing" class="actions">
        <button type="button" class="ghost" data-testid="props-reclassify" @click="reclassify"><RefreshCw :size="13" aria-hidden="true" />{{ t.props.reclassify }}</button>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.props {
  container: document-properties / inline-size;
  display: flex;
  flex-direction: column;
  flex: 0 1 auto;
  min-height: 0;
  overflow: hidden;
  margin: 0 var(--space-7) var(--space-3);
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--canvas);
}
.form {
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: var(--space-3);
  border: 0;
  max-height: min(480px, 55dvh);
  overflow: auto;
}
.property-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: var(--space-3) var(--space-5);
}
.property-group {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--bg-primary);
}
.group-heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-1);
  color: var(--text-normal);
  font-size: inherit;
  font-weight: 600;
}
.group-heading svg { flex: none; color: var(--text-muted); }
.field {
  display: grid;
  grid-template-columns: 5em minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.field--top { align-items: start; }
.field--top .field-label { padding-top: var(--space-2); }
.field-label { color: var(--text-muted); }
.field-control { min-width: 0; }
.field-control > .date-picker { width: 100%; }
.field-hint {
  display: block;
  margin-top: var(--space-1);
  color: var(--text-muted);
  font-size: inherit;
}
input.place-input {
  width: 100%;
  min-width: 0;
  min-height: var(--control-height);
  border-radius: var(--radius-m);
  padding-inline: var(--space-3);
}
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-2);
}
.actions button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--text-muted);
}
@container document-properties (max-width: 740px) {
  .property-groups { grid-template-columns: minmax(0, 1fr); }
}
@container document-properties (max-width: 370px) {
  .field { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
  .field--top .field-label { padding-top: 0; }
}
@container content (max-width: 600px) {
  .props { margin-inline: var(--space-5); }
}
</style>
