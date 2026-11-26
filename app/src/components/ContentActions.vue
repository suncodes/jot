<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Doc, LibraryItem } from '@shared/types'
import { call, invoke } from '@/api'
import { prepareContentAction } from '@/utils/pendingEdits'
import AppDialog from '@/components/AppDialog.vue'
import AppSelect from '@/components/AppSelect.vue'
import ObjectMenu from '@/components/ObjectMenu.vue'
import LogTimeEditor from '@/components/LogTimeEditor.vue'
import ContentDirectorySelect from './ContentDirectorySelect.vue'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryPinsStore } from '@/stores/pins'
import { useToastsStore } from '@/stores/toasts'
import type { MenuAction } from '@/utils/objectActions'
import { t } from '@/strings'

const { path } = defineProps<{ path: string }>()
const tabs = useTabsStore()
const toasts = useToastsStore()
const pins = useLibraryPinsStore()
const item = ref<LibraryItem | null>(null)
const doc = ref<Doc | null>(null)
const timeEditor = ref<InstanceType<typeof LogTimeEditor> | null>(null)
const mode = ref('')
const value = ref('')
const scope = ref('entry')
const summaryTarget = ref('')
const busy = ref(false)
const error = ref('')
const targetPath = computed(() => item.value?.path ?? path)
const heading = computed(() => ({ rename: t.actions.rename, move: t.actions.move, classify: t.actions.classify, delete: t.actions.trash, reprocess: t.actions.reprocess, regenerate: t.actions.regenerate })[mode.value as 'rename'])
const actions = computed<MenuAction[]>(() => {
  if (!doc.value) return []
  const d = doc.value
  const file = item.value?.kind === 'file'
  const list: MenuAction[] = []
  if (file) list.push({ id: 'original', label: t.actions.openOriginal, disabled: item.value?.sourceMissing })
  else if (d.editable) list.push({ id: 'edit', label: t.actions.edit })
  if (d.type === 'log') list.push({ id: 'time', label: t.actions.logTime })
  if (d.type === 'daily') list.push({ id: 'regenerate', label: t.actions.regenerate })
  const ordinary = d.type !== 'daily' && (d.type !== 'source-summary' || file)
  if (ordinary) {
    list.push({ id: 'rename', label: d.type === 'idea' || d.type === 'log' ? t.actions.filename : t.actions.rename, disabled: item.value?.sourceMissing })
    list.push({ id: 'classify', label: t.actions.classify, disabled: false })
    list.push({ id: 'analyze', label: t.props.reclassify, disabled: item.value?.sourceMissing })
    list.push({ id: 'move', label: t.actions.move, disabled: item.value?.sourceMissing })
  }
  list.push({ id: 'pin', label: pins.isPinned(targetPath.value) ? t.pins.remove : t.pins.add, disabled: !pins.isPinned(targetPath.value) && item.value?.sourceMissing })
  list.push({ id: 'copy-path', label: t.actions.copyPath })
  if (file) list.push({ id: 'reprocess', label: t.actions.reprocess, disabled: item.value?.sourceMissing || ['unsupported', 'processing'].includes(item.value?.file?.state ?? '') })
  if (ordinary) list.push({ id: 'delete', label: t.actions.trash, danger: true, separated: true })
  return list.map((a) => ({ ...a, testId: 'content-' + a.id }))
})
async function prepare(): Promise<void> {
  try {
    await pins.refresh().catch(e => toasts.error((e as Error).message))
    item.value = await call('library:resolve', { path })
    summaryTarget.value = item.value?.summaryPath ?? ''
    doc.value = await call('doc:get', { ref: { path: item.value?.summaryPath ?? (item.value?.sourceMissing ? path : targetPath.value) } })
  } catch (e) { toasts.error((e as Error).message); throw e }
}
function stop(): void { mode.value = ''; error.value = '' }
async function regenerate(force = false): Promise<void> {
  await prepareContentAction(targetPath.value)
  const result = item.value?.kind === 'file'
    ? await invoke('files:reprocess', { path: targetPath.value, force, summaryPath: summaryTarget.value || undefined })
    : await invoke('timeline:generateDaily', { date: doc.value!.path.split('/').pop()!.replace(/\.md$/i, ''), force })
  if (!result.ok) {
    if (result.error.code === 'CONFLICT' && !force) { mode.value = item.value?.kind === 'file' ? 'reprocess' : 'regenerate'; return }
    throw new Error(result.error.message)
  }
  toasts.info(t.archive.queued)
  stop()
}
async function choose(action: string): Promise<void> {
  error.value = ''
  try {
    if (action === 'pin') { await pins.set(targetPath.value, 'file', !pins.isPinned(targetPath.value)); return }
    if (action === 'analyze') {
      await prepareContentAction(targetPath.value)
      await call('classify:rerun', { ref: { path: targetPath.value } })
      toasts.info(t.props.reclassifyQueued)
      return
    }
    if (action === 'classify') {
      await tabs.open(targetPath.value, { newTab: true })
      tabs.editProps = item.value?.sourceMissing ? item.value.summaryPath ?? targetPath.value : targetPath.value
      return
    }
    if (action === 'edit') { await tabs.open(targetPath.value, { newTab: true, startEditing: true }); return }
    if (action === 'time') { timeEditor.value?.edit(); return }
    if (action === 'original') { await call('doc:openExternal', { path: targetPath.value }); return }
    if (action === 'copy-path') { await navigator.clipboard.writeText(targetPath.value); toasts.info(t.actions.copied); return }
    if (action === 'reprocess' && (item.value?.summaryPaths?.length ?? 0) > 1) { mode.value = 'reprocess'; return }
    if (action === 'reprocess' || action === 'regenerate') { await regenerate(); return }
    value.value = action === 'rename' ? targetPath.value.split('/').pop()!.replace(/\.(md|markdown)$/i, '') : targetPath.value.split('/').slice(0, -1).join('/')
    scope.value = 'entry'
    if (action === 'move') value.value = 'root'
    mode.value = action
  } catch (e) { toasts.error((e as Error).message) }
}
async function submit(): Promise<void> {
  if (!mode.value || busy.value) return
  busy.value = true; error.value = ''
  try {
    await prepareContentAction(targetPath.value)
    if (mode.value === 'rename' || mode.value === 'move') {
      const before = targetPath.value
      const meta = mode.value === 'rename' ? await call('doc:rename', { ref: { path: before }, newName: value.value.trim() }) : await call('doc:move', { ref: { path: before }, toDir: value.value === 'root' ? 'content' : value.value })
      tabs.retarget(before, meta.path)
      if (meta.notUpdated?.length) toasts.error(t.library.linksNotUpdated + meta.notUpdated.map(item => item.path).join('、'))
      toasts.info(mode.value === 'rename' ? t.actions.renamed : t.actions.moved)
    } else if (mode.value === 'reprocess' || mode.value === 'regenerate') await regenerate(true)
    else {
      const { trashId } = await call('library:delete', { path: targetPath.value, scope: scope.value as 'source' | 'entry' })
      if (!(item.value?.kind === 'file' && scope.value === 'source' && item.value.summaryPath)) tabs.close(targetPath.value)
      toasts.info(t.actions.deleted, { label: t.actions.undo, run: async () => { const restored = await call('doc:restore', { trashId }); await tabs.open(restored.path, { newTab: true }) } })
    }
    stop()
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
</script>
<template>
  <ObjectMenu :actions :prepare trigger-id="content-more" menu-id="content-menu" @select="choose" />
  <LogTimeEditor v-if="doc?.type === 'log'" ref="timeEditor" :doc menu-only />
  <AppDialog v-if="mode" :title="heading" :busy :compact="mode === 'rename'" @close="stop">
    <form @submit.prevent="submit">
      <p class="small muted selectable">{{ targetPath }}</p>
      <label v-if="mode === 'rename'" class="dialog-field">
        {{ t.actions.name }}
        <input v-model="value" class="dialog-input" type="text" maxlength="120" autofocus data-select-on-open data-testid="content-name-input" />
      </label>
      <label v-if="mode === 'move'">{{ t.actions.target }}<ContentDirectorySelect v-model="value" data-testid="content-folder" /></label>
      <label v-if="mode === 'reprocess' && (item?.summaryPaths?.length ?? 0) > 1">{{ t.library.selectSummary }}<AppSelect v-model="summaryTarget" :label="t.library.selectSummary" :options="item!.summaryPaths!.map(path => ({ value: path, label: path }))" /></label>
      <template v-if="mode === 'delete'">
        <p>{{ item?.kind === 'file' ? t.actions.fileDeleteHint : t.actions.noteDeleteHint }}</p>
        <AppSelect v-if="item?.kind === 'file'" v-model="scope" :label="t.actions.trash" :options="[{ value: 'entry', label: t.actions.deleteEntry }, ...(!item.sourceMissing ? [{ value: 'source', label: t.actions.deleteSource }] : [])]" data-testid="content-delete-scope" />
      </template>
      <p v-if="mode === 'reprocess' || mode === 'regenerate'">{{ mode === 'reprocess' ? t.archive.confirmOverwrite : t.today.confirmOverwrite }}</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <div class="dialog-actions"><button type="button" class="ghost" :disabled="busy" @click="stop">{{ t.actions.cancel }}</button><button class="primary" :disabled="busy || ((mode === 'rename' || mode === 'move') && !value.trim())" data-testid="content-confirm">{{ busy ? t.actions.busy : mode === 'delete' ? t.actions.trash : t.actions.confirm }}</button></div>
    </form>
  </AppDialog>
</template>
