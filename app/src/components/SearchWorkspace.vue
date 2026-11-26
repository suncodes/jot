<script setup lang="ts">
import { ChevronDown, ChevronUp, Search, SlidersHorizontal, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, toRef, watch } from 'vue'
import type { DocType, SearchHit } from '@shared/types'
import { call, on } from '@/api'
import { useTabsStore } from '@/stores/tabs'
import { useDocumentSearch } from '@/composables/useDocumentSearch'
import AppSelect from '@/components/AppSelect.vue'
import ContentActions from '@/components/ContentActions.vue'
import Pager from '@/components/Pager.vue'
import DatePicker from '@/components/DatePicker.vue'
import { t } from '@/strings'

type SearchScope = 'all' | 'current'
interface ResultItem {
  id: string
  title: string
  snippet: string
  highlights: readonly (readonly [number, number])[]
  meta: string[]
  path?: string
  hit?: SearchHit
  index?: number
  ai?: boolean
  missing?: boolean
}

const { active = false } = defineProps<{ active?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const tabs = useTabsStore()
const input = ref<HTMLInputElement | null>(null)
const scope = ref<SearchScope>('all')
const query = ref('')
const sort = ref<'relevance' | 'time'>('relevance')
const showFilters = ref(false)
const dateValidity = reactive({ from: true, to: true })
const datesRevision = ref(0)
const validDates = computed(() => dateValidity.from && dateValidity.to)
const filter = reactive({ type: '' as DocType | '', directory: '', from: '', to: '' })
const directories = ref<import('@shared/files').DirectoryItem[]>([])
const hits = ref<SearchHit[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref('')
const searched = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0
let off: (() => void) | undefined
let directoriesSequence = 0

const localEnabled = computed(() => active && scope.value === 'current')
const { matches, current, title: currentTitle, available, documentChanged, count, refresh, select, move, start } =
  useDocumentSearch(query, localEnabled, toRef(() => tabs.activePath))
const types = Object.keys(t.docTypes) as DocType[]
const hasFilter = computed(() => !!(filter.type || filter.directory || filter.from || filter.to))
const canQuery = computed(() => query.value.trim() !== '' || hasFilter.value)
const allResults = computed<ResultItem[]>(() => hits.value.map((hit) => ({
  id: hit.chunk.chunkId, title: hit.doc.title, snippet: hit.snippet, highlights: hit.highlights,
  path: hit.doc.path, hit, ai: hit.doc.generatedByAi, missing: hit.doc.sourceMissing,
  meta: [t.docTypes[hit.doc.type], hit.doc.path.split('/').slice(0, -1).join('/'), hit.doc.created.slice(0, 10)].filter((v): v is string => !!v),
})))
const localResults = computed<ResultItem[]>(() => matches.value.map((m, index) => ({
  id: String(m.from), title: t.search.matchTitle(index + 1),
  snippet: m.snippet, highlights: m.highlights, index,
  meta: [currentTitle.value],
})))
// 两个结果容器常驻，分别保留滚动；共用输入框、结果行与状态处理。
const groups = computed(() => [
  { scope: 'all', items: allResults.value, searched: searched.value, empty: t.empty.searchNone },
  { scope: 'current', items: localResults.value, searched: !!query.value || documentChanged.value, empty: documentChanged.value ? '' : available.value ? t.search.localEmpty : t.search.openDocument },
])

async function run(next = 1): Promise<void> {
  clearTimeout(timer)
  page.value = next
  const mine = ++seq
  error.value = ''
  if (!canQuery.value || !validDates.value) {
    hits.value = []
    total.value = 0
    searched.value = false
    loading.value = false
    return
  }
  loading.value = true
  try {
    const r = await call('search:query', {
      text: query.value.trim() || undefined, sort: sort.value,
      filter: {
        ...(filter.type ? { types: [filter.type] } : {}),
        ...(filter.directory ? { scope: { selection: { kind: 'directory' as const, path: filter.directory, recursive: true } } } : {}),
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.to ? { to: filter.to } : {}),
      },
      limit: 50, offset: (page.value - 1) * 50,
    })
    if (mine !== seq) return
    hits.value = r.items
    total.value = r.total
    searched.value = true
    const last = Math.max(1, Math.ceil(r.total / 50))
    if (page.value > last) void run(last)
  } catch (e) { if (mine === seq) error.value = (e as Error).message }
  finally { if (mine === seq) loading.value = false }
}
function schedule(): void {
  clearTimeout(timer)
  // 立即使旧请求失效，快速输入时不会短暂显示上一词的结果。
  seq++
  timer = setTimeout(() => void run(), 200)
}
watch(query, schedule)
watch(showFilters, (visible) => { if (!visible) dateValidity.from = dateValidity.to = true })
watch([sort, filter, dateValidity], () => void run(), { deep: true })

function clearFilters(): void {
  Object.assign(filter, { type: '', directory: '', from: '', to: '' })
  dateValidity.from = dateValidity.to = true
  datesRevision.value++
}
function open(next?: SearchScope, element?: HTMLElement, selection?: string): void {
  if (next) scope.value = next
  if (selection) query.value = selection
  if (scope.value === 'current') start(element)
  void nextTick(() => { input.value?.focus(); input.value?.select() })
}
function openResult(item: ResultItem, newTab = false): void {
  if (item.index !== undefined) select(item.index)
  else if (item.hit) void tabs.open(item.hit.doc.path, {
    newTab, line: item.hit.chunk.lineStart, title: item.hit.doc.title,
  })
}
function parts(item: ResultItem): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = []
  let pos = 0
  for (const [from, to] of item.highlights) {
    if (from < pos) continue
    if (from > pos) out.push({ text: item.snippet.slice(pos, from), mark: false })
    out.push({ text: item.snippet.slice(from, to), mark: true })
    pos = to
  }
  if (pos < item.snippet.length) out.push({ text: item.snippet.slice(pos), mark: false })
  return out
}
function enter(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (scope.value === 'current') move(e.shiftKey ? -1 : 1)
  else void run()
}
function onKey(e: KeyboardEvent): void {
  if (!localEnabled.value || e.altKey) return
  if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g')) {
    e.preventDefault()
    e.stopPropagation()
    move(e.shiftKey ? -1 : 1)
  }
}
watch(() => active, (visible) => { if (visible && scope.value === 'current') void nextTick(refresh) })
async function refreshDirectories(): Promise<void> {
  const mine = ++directoriesSequence
  try {
    const [content, ideas, inbox] = await Promise.all([
      call('content:directories', { recursive: true }),
      call('content:directories', { parentPath: 'ideas', recursive: true }),
      call('content:directories', { parentPath: 'inbox', recursive: true }),
    ])
    if (mine !== directoriesSequence) return
    directories.value = [
      { path: 'ideas', name: t.directory.ideasPosition, hasChildren: !!ideas.length },
      { path: 'inbox', name: t.directory.pendingPosition, hasChildren: !!inbox.length },
      ...content, ...ideas, ...inbox,
    ]
  } catch { /* 目录暂时不可用时保留已有候选，搜索仍报告自己的实际结果。 */ }
}
onMounted(() => {
  void refreshDirectories()
  off = on('vault:changed', () => { void refreshDirectories(); if (canQuery.value) schedule() })
  window.addEventListener('keydown', onKey, true)
})
onUnmounted(() => {
  off?.()
  clearTimeout(timer)
  seq++; directoriesSequence++
  window.removeEventListener('keydown', onKey, true)
})
defineExpose({ open })
</script>

<template>
  <section class="search" role="search" :aria-label="t.search.workspace" data-testid="search-panel" :aria-busy="scope === 'all' && loading" @keydown.esc.prevent.stop="emit('close')">
    <div class="search-heading"><strong>{{ t.ribbon.search }}</strong><button class="ghost icon" :aria-label="t.common.close" :title="t.common.close" data-testid="search-close" @click="emit('close')"><X :size="15" /></button></div>
    <div class="bar">
      <div class="query-field">
        <Search :size="15" aria-hidden="true" />
        <input ref="input" v-model="query" type="text" :aria-label="t.search.queryLabel" data-testid="search-input" :placeholder="t.search.queryPlaceholder" @keydown.enter.prevent="enter" />
        <button v-if="query" class="ghost icon clear-query" :aria-label="t.search.clearQuery" @click="query = ''; input?.focus()"><X :size="13" /></button>
      </div>
    </div>
    <div class="scope-switch" role="group" :aria-label="t.search.scope">
      <button class="ghost scope-option" :aria-pressed="scope === 'all'" data-testid="search-scope-all" @click="open('all')">{{ t.search.all }}</button>
      <button class="ghost scope-option" :aria-pressed="scope === 'current'" data-testid="search-scope-current" @click="open('current')">{{ t.search.current }}</button>
    </div>
    <div v-if="scope === 'current'" class="current-context small muted" data-testid="search-current-context"><span>{{ t.search.lookingIn }}</span><strong :title="currentTitle">{{ currentTitle || t.search.current }}</strong></div>
    <div v-if="scope === 'current' && documentChanged" class="current-changed small" role="status" data-testid="search-target-changed"><span>{{ t.search.targetChanged }}</span><button class="ghost small" data-testid="search-use-current" @click="open('current')">{{ t.search.useCurrent }}</button></div>
    <div v-if="scope === 'all'" class="filter-bar">
      <button class="ghost filter-button small" :class="{ on: showFilters || hasFilter }" :aria-expanded="showFilters" data-testid="search-filters-toggle" @click="showFilters = !showFilters"><SlidersHorizontal :size="13" />{{ t.search.filters }}<span v-if="hasFilter" class="filter-dot" /></button>
      <span v-if="loading" class="small faint" role="status">{{ t.search.loading }}</span>
    </div>
    <div v-show="scope === 'all' && showFilters" class="filters small" data-testid="search-filters">
      <label><span>{{ t.library.colType }}</span><AppSelect v-model="filter.type" :label="t.library.colType" :options="[{ value: '', label: t.search.allTypes }, ...types.map((ty) => ({ value: ty, label: t.docTypes[ty] }))]" data-testid="filter-type" /></label>
      <label><span>{{ t.directory.title }}</span><AppSelect v-model="filter.directory" :label="t.directory.title" :options="[{ value: '', label: t.library.all }, ...directories.map(d => ({ value: d.path, label: d.path.startsWith('content/') ? d.path.slice(8) : d.path === 'ideas' || d.path === 'inbox' ? d.name : d.path }))]" data-testid="filter-directory" /></label>
      <label><span>{{ t.search.from }}</span><DatePicker :key="'from-' + datesRevision" v-model="filter.from" :label="t.search.from" :max="filter.to || undefined" data-testid="filter-from" @validity="dateValidity.from = $event" /></label>
      <label><span>{{ t.search.to }}</span><DatePicker :key="'to-' + datesRevision" v-model="filter.to" :label="t.search.to" :min="filter.from || undefined" data-testid="filter-to" @validity="dateValidity.to = $event" /></label>
      <button v-if="hasFilter || !validDates" class="ghost" data-testid="filter-clear" @click="clearFilters">{{ t.search.clear }}</button>
    </div>
    <div v-if="scope === 'current' ? !!query && !documentChanged : searched" class="meta small muted">
      <span data-testid="search-count" role="status" aria-live="polite">{{ scope === 'all' ? t.search.count(total) : t.search.matchCount(count) }}</span>
      <AppSelect v-if="scope === 'all'" v-model="sort" :label="t.controls.sort" :options="[{ value: 'relevance', label: t.search.sortRelevance }, { value: 'time', label: t.search.sortTime }]" data-testid="search-sort" />
      <div v-else class="match-navigation">
        <span data-testid="search-position">{{ count ? current + 1 : 0 }} / {{ count }}</span>
        <button class="ghost icon" :disabled="!count" :aria-label="t.search.previousMatch" :title="t.search.previousMatch + ' Shift+Enter'" @click="move(-1)"><ChevronUp :size="14" /></button>
        <button class="ghost icon" :disabled="!count" :aria-label="t.search.nextMatch" :title="t.search.nextMatch + ' Enter'" @click="move(1)"><ChevronDown :size="14" /></button>
      </div>
    </div>
    <div v-if="error && scope === 'all'" class="hint small danger" role="alert">{{ error }} <button class="ghost small" @click="run(page)">{{ t.common.retry }}</button></div>
    <div v-for="group in groups" v-show="scope === group.scope" :key="group.scope" class="results" data-object-list :data-testid="'search-results-' + group.scope" :inert="group.scope === 'all' && loading">
      <div v-if="!validDates && group.scope === 'all'" class="hint small danger" role="alert" data-testid="search-date-error">{{ t.controls.invalidDate }}</div>
      <div v-else-if="!group.searched" class="hint small faint">{{ group.scope === 'all' ? t.empty.searchIdle : t.search.localHint }}</div>
      <div v-else-if="!group.items.length && group.empty" class="hint small faint" :data-testid="scope === group.scope ? 'search-none' : undefined">{{ group.empty }}</div>
      <div v-for="item in group.items" :key="item.id" class="hit-row" :class="{ active: item.path && item.path === tabs.activePath }" :data-object-row="item.path ? '' : undefined">
      <button
        class="ghost hit" :class="{ active: item.index !== undefined ? item.index === current : item.path === tabs.activePath }"
        :data-testid="scope === group.scope ? 'search-hit' : undefined" :data-path="item.path" :data-match="item.index"
        @click="openResult(item, $event.ctrlKey || $event.metaKey)" @auxclick.middle="openResult(item, true)"
      >
        <span class="title"><span class="name">{{ item.title }}</span><span v-if="item.ai" class="ai-badge">{{ t.editor.aiGenerated }}</span><span v-if="item.missing" class="missing small" data-testid="hit-source-missing">{{ t.archive.sourceMissing }}</span></span>
        <span class="snippet small muted"><template v-for="(p, i) in parts(item)" :key="i"><mark v-if="p.mark">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></span>
        <span class="info small faint"><span v-for="(value, index) in item.meta" :key="index">{{ value }}</span></span>
      </button>
      <ContentActions v-if="item.path" :path="item.path" />
      </div>
    </div>
    <Pager v-if="searched && scope === 'all'" class="search-pager" :page :total :size="50" prefix="search" :disabled="loading" @change="run" />
  </section>
</template>

<style scoped>
.search { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.search-heading { height:var(--tabbar-height); display:flex; align-items:center; justify-content:space-between; padding:0 var(--space-3); border-bottom:1px solid var(--border); flex:none; font-size:var(--font-size-small); }
.search-heading strong { font-weight:600; }
.bar { padding:var(--space-3) var(--space-3) var(--space-2); }
.query-field { display:flex; align-items:center; gap:var(--space-2); padding:0 var(--space-2); border:1px solid var(--border); border-radius:var(--radius-s); background:var(--bg-primary); color:var(--text-muted); }
.query-field:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }
.query-field > svg { flex:none; }
.query-field input { flex:1; min-width:0; width:0; height:34px; padding:0; border:0; background:transparent; box-shadow:none; font-size:var(--font-size-small); }
.icon { width:26px; height:28px; min-height:28px; padding:0; display:grid; place-items:center; flex:none; }
.clear-query { width:20px; }
.scope-switch { display:flex; gap:var(--space-1); margin:0 var(--space-3) var(--space-2); padding:3px; background:var(--bg-secondary); border-radius:var(--radius-s); }
.scope-option { flex:1; min-width:0; padding:var(--space-1); color:var(--text-muted); font-size:var(--font-size-small); white-space:nowrap; }
.scope-option[aria-pressed='true'] { color:var(--accent); background:var(--bg-primary); font-weight:600; box-shadow:0 1px 3px rgb(0 0 0 / .04); }
.current-context { display:flex; gap:var(--space-2); align-items:center; padding:var(--space-1) var(--space-3) var(--space-2); overflow:hidden; }
.current-context span { flex:none; }
.current-changed { display:flex; flex-direction:column; align-items:flex-start; gap:var(--space-1); padding:0 var(--space-3) var(--space-2); color:var(--text-muted); }
.current-changed button { padding:0; color:var(--accent); }
.current-context strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-normal); font-weight:500; }
.filter-bar { display:flex; justify-content:space-between; align-items:center; padding:0 var(--space-3) var(--space-2); }
.filter-button { display:flex; align-items:center; gap:var(--space-1); padding:0 var(--space-1); color:var(--text-muted); }
.filter-button.on { color:var(--accent); }
.filter-dot { width:5px; height:5px; background:var(--accent); border-radius:50%; }
.filters { display:grid; grid-template-columns:minmax(0,1fr); gap:var(--space-3); padding:0 var(--space-3) var(--space-3); max-height:40vh; overflow:auto; }
.filters label { display:grid; gap:var(--space-1); min-width:0; color:var(--text-muted); }
.filters .app-select, .filters .date-picker { width:100%; }
.meta { display:flex; justify-content:space-between; align-items:center; gap:var(--space-1); padding:var(--space-1) var(--space-3) var(--space-2); border-bottom:1px solid var(--border); }
.match-navigation { display:flex; align-items:center; font-variant-numeric:tabular-nums; white-space:nowrap; }
.match-navigation > span { margin-right:var(--space-1); }
.results { flex:1; overflow:auto; padding:var(--space-2); }
.hint { padding:var(--space-3) var(--space-2); }
.hit-row { display:flex; align-items:flex-start; border-radius:var(--radius-s); }
.hit-row > :deep(.object-more) { margin-top:var(--space-2); }
.hit { display:block; flex:1; min-width:0; width:100%; padding:var(--space-3) var(--space-2); margin-bottom:var(--space-1); border-radius:var(--radius-s); text-align:left; }
.hit.active { background:var(--accent-soft); }
.title { display:flex; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); font-weight:600; }
.missing { flex:none; color:var(--danger); font-weight:400; }
.name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.snippet { margin:var(--space-1) 0 var(--space-2); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; white-space:pre-wrap; line-height:1.8; }
mark { background:var(--accent-soft); color:var(--accent); border-radius:2px; }
.hit.active mark { background:var(--bg-primary); }
.info { display:flex; flex-wrap:wrap; gap:0 var(--space-2); overflow-wrap:anywhere; }
.danger { color:var(--danger); }
.search-pager { padding:var(--space-2) var(--space-3); border-top:1px solid var(--border); }
</style>

<style>
::highlight(jot-find) { background:var(--accent-soft); color:var(--text-normal); }
::highlight(jot-find-current) { background:var(--accent); color:var(--on-accent); }
</style>
