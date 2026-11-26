<script setup lang="ts">
import { FilePlus2, RefreshCw } from 'lucide-vue-next'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { FileItem } from '@shared/types'
import { call, invoke, on } from '@/api'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import Pager from '@/components/Pager.vue'
import ContentActions from '@/components/ContentActions.vue'
import { REVIEW_TAB } from '@/stores/tabs'
import { t } from '@/strings'
import { formatFileSize as size } from '@/utils/fileSize'

// 文件处理：放进来的全部原件及处理状态。见 docs/user-guide.md。
const tabs = useTabsStore()
const toasts = useToastsStore()
const items = ref<FileItem[]>([])
const loaded = ref(false)
const page = ref(1)
const total = ref(0)
const error = ref('')
const loading = ref(false)
const pageSize = 50
let sequence = 0
const expanded = ref<string | null>(null)
const picker = ref<HTMLInputElement | null>(null)
const offs: (() => void)[] = []
let timer: ReturnType<typeof setTimeout> | undefined

async function refresh(): Promise<void> {
  const mine = ++sequence
  loading.value = true
  try {
    const result = await call('files:list', { limit: pageSize, offset: (page.value - 1) * pageSize })
    if (mine !== sequence) return
    total.value = result.total
    const last = Math.max(1, Math.ceil(result.total / pageSize))
    if (page.value > last) { page.value = last; return }
    items.value = result.items
    loaded.value = true
    error.value = ''
  } catch (e) { if (mine === sequence) error.value = (e as Error).message }
  finally { if (mine === sequence) loading.value = false }
}
watch(page, () => { expanded.value = null; void refresh() })
function refreshSoon(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void refresh(), 100)
}

const name = (p: string) => p.split('/').pop()!

/** 点击一行：已完成的打开摘要页；其余的展开看详情 */
function onRow(item: FileItem): void {
  if (item.state === 'done' && item.summaryPath) tabs.open(item.path, { newTab: true })
  else expanded.value = expanded.value === item.path ? null : item.path
}

async function openOriginal(item: FileItem): Promise<void> {
  if (item.text) tabs.open(item.path, { newTab: true, reader: 'source' })
  else await call('doc:openExternal', { path: item.path })
}

async function reprocess(item: FileItem, force = false): Promise<void> {
  const r = await invoke('files:reprocess', { path: item.path, force })
  if (r.ok) toasts.info(t.archive.queued)
  else if (r.error.code === 'CONFLICT') toasts.error(t.archive.confirmOverwrite, { label: t.archive.overwrite, run: () => reprocess(item, true) })
  else toasts.error(r.error.message)
}

async function onPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  await importFiles([...(input.files ?? [])])
  input.value = ''
}

async function importFiles(files: File[]): Promise<void> {
  const paths = files.map((f) => window.jot.pathForFile(f)).filter(Boolean)
  if (!paths.length) {
    if (files.length) toasts.error(t.archive.noPath)
    return
  }
  const r = await call('files:import', { paths })
  if (r.imported.length) toasts.info(t.archive.imported(r.imported.length))
  for (const s of r.skipped) toasts.error(t.archive.skipped(s.path.split(/[\\/]/).pop()!, s.reason))
}

onMounted(() => {
  void refresh()
  offs.push(on('files:changed', refreshSoon), on('vault:changed', refreshSoon), on('jobs:updated', refreshSoon), on('doc:updated', refreshSoon))
})
onUnmounted(() => {
  clearTimeout(timer)
  offs.forEach((off) => off())
})
defineExpose({ importFiles })
</script>

<template>
  <div class="archive" data-testid="archive-view">
    <div class="page">
      <header class="bar"><h1>{{ t.archive.title }}</h1><button data-testid="archive-add" @click="picker?.click()"><FilePlus2 :size="14" />{{ t.library.import }}</button><input ref="picker" type="file" multiple hidden data-testid="archive-picker" @change="onPicked" /></header>
      <p class="intro small muted">{{ t.archive.intro }}</p>
      <div class="guide small"><span class="muted">{{ t.archive.classificationHint }}</span><button class="ghost" data-testid="archive-review" @click="tabs.open(REVIEW_TAB, { newTab: true, title: t.inbox.title })">{{ t.inbox.title }}</button></div>
      <div v-if="error" class="bad small" role="alert">{{ error }} <button @click="refresh">{{ t.common.retry }}</button></div>
      <div v-else-if="loaded && !items.length" class="empty muted" data-testid="archive-empty">{{ t.archive.empty }}</div>
      <div v-else class="table-wrap">
        <table class="small" :aria-busy="loading">
          <thead><tr><th>{{ t.archive.colName }}</th><th>{{ t.archive.colState }}</th><th>{{ t.archive.colClassification }}</th><th /></tr></thead>
          <tbody><template v-for="item in items" :key="item.path">
            <tr class="row" data-testid="archive-row" data-object-row :data-path="item.path" :data-state="item.state" @click="onRow(item)">
              <td class="name"><button class="ghost filename" @click.stop="onRow(item)">{{ name(item.path) }}</button><div class="faint">{{ size(item.size) }} · {{ item.addedAt.slice(0, 10) }}</div></td>
              <td><span class="state" :class="item.state">{{ t.archive.states[item.state] }}</span></td>
              <td class="classification"><template v-if="item.classification"><span v-for="tag in item.classification.tags" :key="tag">#{{ tag }}</span></template><span v-else class="faint">{{ t.library.unclassified }}</span></td>
              <td class="ops"><button class="ghost" :title="t.archive.openOriginal" data-testid="archive-open-original" @click.stop="openOriginal(item)">{{ t.archive.openOriginal }}</button><button v-if="item.state === 'failed' || item.state === 'waiting-model'" class="ghost icon" :title="t.archive.reprocess" data-testid="archive-reprocess" @click.stop="reprocess(item)"><RefreshCw :size="14" /></button><ContentActions :path="item.path" /></td>
            </tr>
            <tr v-if="item.note || expanded === item.path || item.state === 'failed'" class="detail"><td colspan="4" data-testid="archive-detail"><div v-if="expanded === item.path" class="faint selectable">{{ item.path }}</div><div v-if="item.note" class="warn">{{ item.note }}</div><div v-if="item.error" class="selectable" :class="item.state === 'failed' ? 'bad' : 'muted'">{{ item.error }}</div><div v-if="item.state === 'unsupported'" class="muted">{{ t.archive.unsupportedHint }}</div></td></tr>
          </template></tbody>
        </table>
      </div>
      <Pager :page="page" :total="total" :size="pageSize" prefix="archive" :disabled="loading" @change="page = $event" />
    </div>
  </div>
</template>

<style scoped>
.archive { height:100%; overflow:auto; }
.bar { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); }
.bar button { display:flex; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); white-space:nowrap; }
h1 { margin:0; font-size:var(--font-size-title); font-weight:650; }
.intro { margin:var(--space-2) 0 var(--space-5); }
.guide { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); padding:var(--space-3) var(--space-4); border:1px solid var(--border); border-radius:var(--radius-m); background:var(--canvas); margin-bottom:var(--space-5); }
.guide button { color:var(--accent); font-size:inherit; flex:none; }
.empty { padding:var(--space-8) 0; text-align:center; }
.table-wrap { overflow:auto; }
table { width:100%; border-collapse:collapse; }
th { text-align:left; font-weight:500; color:var(--text-muted); padding:var(--space-2); border-bottom:1px solid var(--border); white-space:nowrap; }
td { padding:var(--space-4) var(--space-2); border-bottom:1px solid var(--border); vertical-align:middle; }
.row:hover { background:var(--canvas); }
.name { min-width:150px; overflow-wrap:anywhere; }
.filename { text-align:left; padding:0; font-weight:550; min-height:0; font-size:var(--font-size-ui); }
.state { white-space:nowrap; padding:2px var(--space-2); border-radius:var(--radius-s); background:var(--bg-secondary); color:var(--text-muted); }
.state.done { color:var(--success); }
.state.failed, .bad { color:var(--danger); }
.state.waiting-model, .warn { color:var(--warning); }
.classification { min-width:100px; }
.pending { display:block; color:var(--warning); }
.ops { white-space:nowrap; text-align:right; }
.ops button { padding:var(--space-1); font-size:var(--font-size-small); white-space:nowrap; }
.icon { display:inline-grid; vertical-align:middle; }
.detail td { background:var(--canvas); padding:var(--space-3); overflow-wrap:anywhere; }
@container content (max-width:600px) { .guide { align-items:flex-start; } td, th { padding:var(--space-3) var(--space-1); } .ops { white-space:normal; } }
</style>
