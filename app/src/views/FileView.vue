<script setup lang="ts">
import { ExternalLink, FileText, RefreshCw, Sparkles } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, useId, watch, watchEffect } from 'vue'
import type { Doc, LibraryItem } from '@shared/types'
import { call, invoke, on } from '@/api'
import { mappedPath } from '@shared/files'
import ContentProvenance from '@/components/ContentProvenance.vue'
import DocumentToolbar from '@/components/DocumentToolbar.vue'
import PropertyButton from '@/components/PropertyButton.vue'
import AppSelect from '@/components/AppSelect.vue'
import { prepareContentAction } from '@/utils/pendingEdits'
import PropertyPanel from '@/components/PropertyPanel.vue'
import DocView from '@/views/DocView.vue'
import type { Tab } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
import { formatFileSize as size } from '@/utils/fileSize'
import { useEditorContextStore } from '@/stores/editorContext'
const { item, tab, active } = defineProps<{ item: LibraryItem; tab: Tab; active: boolean }>()
const propertiesOpen = ref(false)
const propertiesId = useId()
const toasts = useToastsStore()
const mode = ref<'summary' | 'source'>(tab.reader ?? (item.summaryPath ? 'summary' : 'source'))
const selectedSummary = ref(item.summaryPath ?? '')
const summaryPath = computed(() => selectedSummary.value || item.summaryPath)
const summaryOptions = computed(() => {
  const paths = [...new Set([item.summaryPath, ...(item.summaryPaths ?? [])].filter((path): path is string => !!path))]
  const options = paths.map(path => ({ value: path, label: path }))
  if (summaryPath.value && !paths.includes(summaryPath.value)) options.push({ value: summaryPath.value, label: summaryPath.value + ' · ' + t.directory.missing })
  return options
})
const summary = ref<Doc | null>(null)
const source = ref<Doc | null>(null)
const propertyDoc = computed(() => source.value ?? summary.value)
const editorContext = useEditorContextStore()
const contextOwner = crypto.randomUUID()
watchEffect(() => {
  if (active && mode.value === 'source' && !item.sourceMissing && item.file && !item.file.text) editorContext.publish(contextOwner, { path: item.path, title: item.title, body: '', dirty: false })
  else editorContext.clear(contextOwner)
})
onBeforeUnmount(() => editorContext.clear(contextOwner))
const embedded = computed<Tab>(() => ({ ...tab, path: mode.value === 'summary' && summaryPath.value ? summaryPath.value : item.path }))
let loadSequence = 0
async function loadSummary(): Promise<void> {
  const request = ++loadSequence
  const [original, result] = await Promise.all([
    item.sourceMissing ? null : invoke('doc:get', { ref: { path: item.path } }),
    summaryPath.value ? invoke('doc:get', { ref: { path: summaryPath.value } }) : null,
  ])
  if (request !== loadSequence) return
  source.value = original?.ok ? original.data : null
  summary.value = result?.ok ? result.data : null
}
async function changeReader(reader: 'summary' | 'source', selection = selectedSummary.value): Promise<void> {
  try {
    await prepareContentAction(embedded.value.path)
    selectedSummary.value = selection
    mode.value = reader
  } catch (error) { toasts.error((error as Error).message) }
}
async function reprocess(force = false): Promise<void> {
  try {
    await prepareContentAction(summaryPath.value ?? item.path)
    const r = await invoke('files:reprocess', { path: item.path, force, summaryPath: summaryPath.value })
    if (r.ok) toasts.info(t.archive.queued)
    else if (r.error.code === 'CONFLICT') toasts.error(t.archive.confirmOverwrite, { label: t.archive.overwrite, run: () => reprocess(true) })
    else toasts.error(r.error.message)
  } catch (error) { toasts.error((error as Error).message) }
}
watch(() => [item.path, item.summaryPath, item.modified, item.classification, summaryPath.value], () => void loadSummary())
watch(() => tab.reader, (reader) => { if (reader) void changeReader(reader) })
const offMove = on('storage:changed', change => {
  if (change.moves && selectedSummary.value) selectedSummary.value = mappedPath(selectedSummary.value, change.moves)
})
onBeforeUnmount(() => { loadSequence++; offMove() })
onMounted(() => void loadSummary())
</script>

<template>
  <div class="file-view" data-testid="file-view" :data-path="item.path" :data-reader="mode" data-find-scope :data-find-active="active" :data-find-title="item.title + ' · ' + (mode === 'summary' ? t.library.summary : t.library.source)">
    <header class="file-head">
      <DocumentToolbar class="detail-toolbar" :path="item.path"><button v-if="!item.sourceMissing" type="button" class="ghost document-tool" data-testid="file-open-external" :title="t.editor.openExternal" :aria-label="t.editor.openExternal" @click="call('doc:openExternal', { path: item.path })"><ExternalLink :size="15" aria-hidden="true" /></button></DocumentToolbar>
      <span class="type-badge type-file">{{ t.library.file }}</span>
      <div class="file-title-row"><h1 data-testid="file-title">{{ item.title }}</h1><PropertyButton v-if="propertyDoc" v-model="propertiesOpen" :doc="propertyDoc" :panel-id="propertiesId" /></div>
      <div class="reader-tabs" :aria-label="t.library.file"><button class="ghost" :aria-pressed="mode === 'summary'" :disabled="!item.summaryPath" data-testid="file-summary" @click="changeReader('summary')"><Sparkles :size="14" />{{ t.library.summary }}</button><button class="ghost" :aria-pressed="mode === 'source'" data-testid="file-source" @click="changeReader('source')"><FileText :size="14" />{{ t.library.source }}</button></div>
      <AppSelect v-if="summaryOptions.length > 1" :model-value="summaryPath ?? ''" :label="t.library.selectSummary" :options="summaryOptions" data-testid="file-summary-select" @update:model-value="changeReader(mode, $event)" />
      <div class="context small muted"><span>{{ mode === 'summary' ? t.library.summaryHint : t.library.currentSource }}</span><span v-if="item.file" data-testid="file-state">{{ t.archive.states[item.file.state] }}</span><button v-if="!item.sourceMissing && item.file && item.file.state !== 'unsupported'" class="ghost" data-testid="file-reprocess" @click="reprocess()"><RefreshCw :size="12" />{{ t.archive.reprocess }}</button></div>
      <p v-if="item.sourceMissing" class="small notice" data-testid="doc-source-missing">{{ t.archive.sourceMissing }}</p>
      <p v-if="!item.summaryPath" class="small muted" data-testid="file-no-summary">{{ t.library.noSummary }}</p>
      <p v-if="item.file?.error || item.file?.note" class="small notice selectable" data-testid="file-notice">{{ item.file.error || item.file.note }}</p>
    </header>
    <PropertyPanel v-if="propertyDoc" :id="propertiesId" v-model:open="propertiesOpen" :doc="propertyDoc" :can-reclassify="!!item.summaryPath && !item.sourceMissing" @updated="source ? source = { ...source, classification: $event } : summary = { ...summary!, classification: $event }" />
    <div v-if="mode === 'source' && item.sourceMissing && !item.file?.text" class="state muted">{{ t.archive.sourceMissing }}</div>
    <div v-else-if="mode === 'source' && item.file && !item.file.text" class="state muted"><p>{{ t.library.noPreview }}</p><button data-testid="doc-open-external" @click="call('doc:openExternal', { path: item.path })">{{ t.editor.openExternal }}</button></div>
    <DocView v-else :key="mode" class="file-body" :tab="embedded" :active :embedded="true" :read-only="false" />
    <details class="location small" data-testid="file-location"><summary>{{ t.library.location }}</summary><ContentProvenance v-if="summary" :path="summary.path" /><dl class="selectable"><dt>{{ t.library.source }}</dt><dd>{{ item.path }}</dd><template v-if="item.summaryPath"><dt>{{ t.library.summary }}</dt><dd>{{ summaryPath }}</dd></template><template v-if="item.file"><dt>{{ t.archive.colAdded }}</dt><dd>{{ new Date(item.created).toLocaleString('zh-CN') }} · {{ size(item.file.size) }}</dd></template></dl></details>
  </div>
</template>

<style scoped>
.file-view { height:100%; min-height:0; overflow:auto; }
.file-head { padding:var(--space-5) var(--space-7) 0; flex:none; }
.detail-toolbar { margin-bottom:var(--space-5); }
.file-title-row { display:flex; align-items:flex-start; gap:var(--space-3); margin:var(--space-3) 0 var(--space-5); }
.file-title-row > h1 { flex:1; min-width:0; }
.file-title-row > .property-button { margin-top:var(--space-1); }
h1 { font-size:var(--font-size-title); font-weight:650; line-height:1.4; letter-spacing:-.6px; margin:0; overflow-wrap:anywhere; }
.reader-tabs { display:flex; width:max-content; max-width:100%; gap:var(--space-1); padding:var(--space-1); border:1px solid var(--border); border-radius:var(--radius-m); }
.reader-tabs button { display:flex; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); }
.reader-tabs [aria-pressed='true'] { color:var(--accent); background:var(--accent-soft); }
.context { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-3); padding:var(--space-3) 0; }
.context > span:first-child { margin-right:auto; }
.context button { display:flex; align-items:center; gap:var(--space-1); padding:0; font-size:inherit; color:var(--accent); }
.file-body { min-height:0; }
.notice { color:var(--warning); }
.state { flex:1; min-height:100px; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:var(--space-5); text-align:center; }
.location { flex:none; padding:var(--space-3) var(--space-7); border-top:1px solid var(--border); color:var(--text-muted); max-height:180px; overflow:auto; }
.location summary { cursor:pointer; }
dl { display:grid; grid-template-columns:auto 1fr; gap:var(--space-2); overflow-wrap:anywhere; }dd { margin:0; }
@container content (max-width:600px) { .file-head { padding:var(--space-4) var(--space-5) 0; }.location { padding:var(--space-3) var(--space-5); } }
</style>
