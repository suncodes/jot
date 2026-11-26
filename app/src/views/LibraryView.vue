<script setup lang="ts">
import { ChevronRight, FileText, Folder, Lightbulb, NotebookPen, Search, StickyNote, Upload } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LibraryFacets, LibraryItem, LibraryKind, LibraryQuery } from '@shared/types'
import type { ContentScope } from '@shared/storage'
import { invoke, on } from '@/api'
import { useLibraryStore } from '@/stores/library'
import { useTabsStore } from '@/stores/tabs'
import AppSelect from '@/components/AppSelect.vue'
import FolderActions from '@/components/FolderActions.vue'
import ContentActions from '@/components/ContentActions.vue'
import Pager from '@/components/Pager.vue'
import { t } from '@/strings'

const { active } = defineProps<{ active: boolean }>()
const emit = defineEmits<{ import: []; review: []; capture: [] }>()
const library = useLibraryStore()
const tabs = useTabsStore()
const items = ref<LibraryItem[]>([])
const facets = ref<LibraryFacets>({ months: [], tags: [] })
const total = ref(0)
const error = ref('')
const loading = ref(false)
const scroll = ref<HTMLDivElement | null>(null)
const pageSize = 30
const kinds: (LibraryKind | '')[] = ['', 'record', 'note', 'file']
const icons = { record: StickyNote, note: NotebookPen, file: FileText }
const label = (kind: LibraryKind | '') => kind ? t.library[kind] : t.library.allTypes
const dateLabel = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll('-', '/') : new Date(value).toLocaleDateString('zh-CN')
const isIdeas = computed(() => library.scope.collection === 'ideas')
const isPending = computed(() => library.scope.collection === 'pending')
const children = computed(() => library.children)
const filtered = computed(() => !!(library.filters.text || library.filters.kind || library.filters.fileState || library.filters.month || library.filters.tag))
const baseScope = computed<ContentScope>(() => ({
  selection: library.scope.directoryPath ? { kind: 'directory', path: library.scope.directoryPath, recursive: false }
    : { kind: 'collection', name: library.scope.collection! },
}))
const query = computed<LibraryQuery>(() => {
  const scope = { ...baseScope.value }
  if (isIdeas.value && library.filters.month) {
    const month = library.filters.month
    const [year, number] = month.split('-').map(Number)
    scope.time = { basis: 'recorded', from: month + '-01', to: month + '-' + new Date(year!, number!, 0).getDate() }
  }
  return {
    scope, filter: isIdeas.value && library.filters.tag ? { tags: [library.filters.tag] } : undefined,
    kind: library.filters.kind || undefined, text: library.filters.text, sort: library.filters.sort,
    fileState: library.filters.kind === 'file' ? library.filters.fileState || undefined : undefined,
    limit: pageSize, offset: (library.filters.page - 1) * pageSize,
  }
})
const months = computed(() => [
  { value: '', label: t.library.allMonths },
  ...[...new Set([...facets.value.months, library.filters.month].filter(Boolean))].sort((a, b) => b.localeCompare(a)).map(month => ({ value: month, label: t.library.monthLabel(month) })),
])
const tags = computed(() => {
  const values = [...facets.value.tags]
  const selected = library.filters.tag
  if (selected && !values.some(tag => tag.name === selected)) values.push({ name: selected, count: 0 })
  return [{ value: '', label: t.library.allTags }, ...values.map(tag => ({ value: tag.name, label: tag.name + ' · ' + tag.count }))]
})
const sorts = computed(() => [
  ...(isIdeas.value ? [{ value: 'created' as const, label: t.library.recentRecorded }] : []),
  { value: 'updated' as const, label: t.library.updated }, { value: 'name' as const, label: t.library.name },
])
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
const offs: (() => void)[] = []
async function load(): Promise<void> {
  const tick = ++sequence
  if (library.unavailable) { error.value = ''; items.value = []; total.value = 0; loading.value = false; return }
  loading.value = true
  const [result, candidates] = await Promise.all([
    invoke('library:query', query.value),
    isIdeas.value ? invoke('library:facets', { scope: baseScope.value }) : Promise.resolve(null),
  ])
  if (tick !== sequence) return
  if (!result.ok || candidates && !candidates.ok) {
    error.value = !result.ok ? result.error.message : candidates && !candidates.ok ? candidates.error.message : ''
    loading.value = false
    return
  }
  error.value = ''
  facets.value = candidates?.ok ? candidates.data : { months: [], tags: [] }
  total.value = result.data.total
  const last = Math.max(1, Math.ceil(total.value / pageSize))
  if (library.filters.page > last) { library.filters.page = last; return }
  items.value = result.data.items
  await nextTick()
  if (active && scroll.value) scroll.value.scrollTop = library.scrollTop
  loading.value = false
}
function rememberScroll(): void {
  if (!loading.value && active && scroll.value?.offsetParent) library.scrollTop = scroll.value.scrollTop
}
function schedule(): void { clearTimeout(timer); sequence++; loading.value = true; timer = setTimeout(() => void load(), 160) }
watch([query, () => library.unavailable], schedule)
watch(() => active, async (value) => {
  if (value) { await nextTick(); if (!loading.value && scroll.value) scroll.value.scrollTop = library.scrollTop }
})
function changePage(value: number): void {
  library.scrollTop = 0
  library.filters.page = value
}
onMounted(() => {
  void load()
  offs.push(on('vault:changed', schedule), on('doc:updated', schedule), on('files:changed', schedule), on('storage:changed', schedule), on('jobs:updated', schedule))
})
onUnmounted(() => { sequence++; clearTimeout(timer); offs.forEach(off => off()) })
</script>

<template>
  <div class="library-layout">
    <div ref="scroll" class="library-view" data-testid="library-view" @scroll="rememberScroll">
      <div class="page">
        <div class="breadcrumb small muted"><button class="ghost" @click="library.select({ collection: 'all' })">{{ t.library.title }}</button><template v-for="ancestor in library.ancestors" :key="ancestor.path"><ChevronRight :size="12" /><button class="ghost" @click="library.select({ directoryPath: ancestor.path })">{{ ancestor.path.split('/').pop() }}</button></template><template v-if="library.scope.collection !== 'all'"><ChevronRight :size="12" /><span>{{ library.title }}</span></template></div>
        <header class="heading">
          <h1 data-testid="library-title">{{ library.title }}</h1>
          <button v-if="isIdeas" data-testid="ideas-write" @click="emit('capture')"><Lightbulb :size="14" />{{ t.library.writeIdea }}</button>
          <button v-else :disabled="library.unavailable" data-testid="library-import" @click="emit('import')"><Upload :size="14" />{{ t.library.import }}</button>
        </header>
        <p class="description muted">{{ isIdeas ? t.library.ideasIntro : isPending ? t.directory.pendingHint : t.library.intro }}</p>
        <p v-if="library.unavailable" class="muted" data-testid="directory-unavailable">{{ t.directory.unavailable }} · {{ library.scope.directoryPath }}</p>
        <button v-if="isPending" class="ghost review-link" data-testid="library-review" @click="emit('review')">{{ t.library.review }}<ChevronRight :size="14" /></button>
        <section v-if="children.length" class="subdirectories">
          <h2>{{ t.library.children }}</h2>
          <div class="directory-grid"><div v-for="p in children" :key="p.path" class="directory-link" data-object-row><button data-testid="library-child" class="ghost" @click="library.select({ directoryPath: p.path })"><span class="folder"><Folder :size="18" /></span><span>{{ p.path.split('/').pop() }}</span><ChevronRight :size="14" /></button><FolderActions :path="p.path" /></div></div>
        </section>
        <h2 v-if="library.scope.directoryPath" class="list-heading">{{ t.library.direct }}</h2>
        <div class="filters">
          <template v-if="isIdeas">
            <AppSelect v-model="library.filters.month" :label="t.library.recordedMonth" :options="months" searchable data-testid="ideas-month" />
            <AppSelect v-model="library.filters.tag" :label="t.library.tag" :options="tags" searchable data-testid="ideas-tag" />
          </template>
          <div v-else class="type-filters" :aria-label="t.library.colType"><button v-for="kind in kinds" :key="kind" class="ghost" :class="{ selected: library.filters.kind === kind }" :aria-pressed="library.filters.kind === kind" data-testid="library-kind" :data-kind="kind" @click="library.filters.kind = kind">{{ label(kind) }}</button></div>
          <label class="search"><Search :size="14" /><input v-model="library.filters.text" type="text" maxlength="200" data-testid="library-search" :aria-label="t.library.search" :placeholder="t.library.search" /></label>
        </div>
        <div class="sort-row">
          <span class="small muted" data-testid="library-count">{{ t.library.resultCount(total) }}</span>
          <button v-if="filtered" class="ghost small" data-testid="library-clear-filters" @click="library.clearFilters">{{ t.library.clearFilters }}</button>
          <span class="grow" />
          <AppSelect v-if="library.filters.kind === 'file'" v-model="library.filters.fileState" :label="t.library.allStates" :options="[{ value: '', label: t.library.allStates }, ...Object.entries(t.archive.states).map(([value, label]) => ({ value, label }))]" data-testid="library-state" />
          <AppSelect v-model="library.filters.sort" :label="t.controls.sort" :options="sorts" data-testid="library-sort" />
        </div>
        <div v-if="error" class="error" role="alert">{{ t.library.loadFailed }}：{{ error }} <button @click="load">{{ t.common.retry }}</button></div>
        <div v-else-if="!items.length" class="empty muted" data-testid="library-empty">{{ loading ? t.library.loading : filtered ? t.library.noResults : isIdeas ? t.library.ideasEmpty : t.library.empty }}</div>
        <table v-else class="content-table" :class="{ 'ideas-table': isIdeas }" :aria-busy="loading" :inert="loading">
          <thead><tr><th>{{ t.library.colName }}</th><th>{{ isIdeas ? t.library.tag : t.library.colType }}</th><th>{{ isIdeas ? t.library.recorded : t.library.colUpdated }}</th><th class="actions-col"><span class="visually-hidden">操作</span></th></tr></thead>
          <tbody data-object-list><tr v-for="item in items" :key="item.path" data-testid="library-item" :data-path="item.path" :data-kind="item.kind" data-object-row>
            <td><button class="item-name ghost" data-testid="library-item-open" :title="item.title" @click="tabs.open(item.path, { newTab: true, title: item.title })"><span class="item-icon" :class="'type-' + item.kind"><component :is="icons[item.kind]" :size="17" /></span><span class="item-copy"><strong>{{ item.title }}</strong><small>{{ item.sourceMissing ? t.archive.sourceMissing : item.preview || (item.file ? t.archive.states[item.file.state] : t.library.emptyPreview) }}</small></span></button></td>
            <td v-if="isIdeas"><div v-if="item.classification.tags.length" class="tag-list"><button v-for="tag in item.classification.tags.slice(0, 2)" :key="tag" class="ghost tag" :title="tag" data-testid="ideas-item-tag" @click="library.filters.tag = tag">#{{ tag }}</button><span v-if="item.classification.tags.length > 2" class="small muted" :title="item.classification.tags.slice(2).join('、')">+{{ item.classification.tags.length - 2 }}</span></div><span v-else class="small muted">—</span></td>
            <td v-else><span class="type-badge" :class="'type-' + item.kind">{{ label(item.kind) }}</span></td>
            <td class="date small muted" data-testid="library-item-date">{{ dateLabel(isIdeas ? item.created : item.modified) }}</td><td class="actions-col"><ContentActions :path="item.path" /></td>
          </tr></tbody>
        </table>
      </div>
    </div>
    <div class="pagination">
      <Pager :page="library.filters.page" :total :size="pageSize" prefix="library" :disabled="loading || !!error" @change="changePage" />
    </div>
  </div>
</template>

<style scoped>
.library-layout { display:grid; grid-template-rows:minmax(0, 1fr) auto; height:100%; }
.library-view, .pagination { scrollbar-gutter:stable; }
.library-view { overflow:auto; }
.breadcrumb { flex-wrap:wrap; overflow-wrap:anywhere; display:flex; gap:var(--space-2); align-items:center; margin-bottom:var(--space-3); }
.breadcrumb button { padding:0; min-height:0; color:inherit; }
.heading { display:flex; align-items:center; justify-content:space-between; gap:var(--space-4); }
h1 { margin:0; font-size:var(--font-size-title); letter-spacing:-.7px; font-weight:650; }
.heading button, .review-link { display:flex; align-items:center; gap:var(--space-2); white-space:nowrap; font-size:var(--font-size-small); }
.description { margin:var(--space-2) 0 var(--space-5); font-size:var(--font-size-small); }
.subdirectories { margin:var(--space-5) 0; }
h2 { font-size:var(--font-size-small); color:var(--text-muted); font-weight:500; margin:0 0 var(--space-3); }
.directory-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-3); }
.directory-link { display:flex; align-items:center; gap:var(--space-3); border:1px solid var(--border); border-radius:var(--radius-m); padding:var(--space-2); text-align:left; min-width:0; }
.directory-link > button { display:flex; align-items:center; gap:var(--space-3); flex:1; min-width:0; text-align:left; }
.directory-link > button > span:nth-child(2) { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.folder { display:grid; place-items:center; width:var(--space-6); height:var(--space-6); background:var(--canvas); color:var(--text-muted); border-radius:var(--radius-s); }
.filters { display:flex; align-items:center; gap:var(--space-3); flex-wrap:wrap; margin-top:var(--space-4); }
.filters :deep(.app-select) { max-width:200px; }
.type-filters { display:flex; gap:var(--space-1); }
.type-filters button { font-size:var(--font-size-small); white-space:nowrap; }
.selected { background:var(--accent-soft); color:var(--accent); }
.search { margin-left:auto; flex:1; min-width:170px; display:flex; align-items:center; gap:var(--space-2); border:1px solid var(--border); border-radius:var(--radius-s); padding:0 var(--space-2); color:var(--text-muted); max-width:300px; }
.search input { border:0; min-width:0; width:100%; padding:var(--space-2) 0; font-size:var(--font-size-small); background:transparent; }
.search:focus-within { border-color:var(--accent); }
.sort-row { display:flex; gap:var(--space-2); align-items:center; flex-wrap:wrap; padding:var(--space-3) 0; }
.grow { flex:1; }
.content-table { border-collapse:collapse; width:100%; table-layout:fixed; }
.content-table[aria-busy="true"] { opacity:.55; }
th { text-align:left; font-size:var(--font-size-small); font-weight:400; color:var(--text-faint); padding:var(--space-2) 0; border-bottom:1px solid var(--border); }
.actions-col { width:36px; text-align:right; }.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
th:nth-child(2) { width:86px; } th:nth-child(3) { width:100px; }
.ideas-table th:nth-child(2) { width:150px; }
td { border-bottom:1px solid var(--surface-line); padding:var(--space-3) 0; }
.item-name { width:100%; display:flex; gap:var(--space-3); align-items:center; padding:0 var(--space-3) 0 0; text-align:left; }
.item-name:hover { background:transparent; color:var(--accent); }
.item-icon { flex:none; width:var(--space-6); height:var(--space-6); display:grid; place-items:center; border-radius:var(--radius-s); }
.item-copy { min-width:0; }
.item-copy strong { display:block; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.item-copy small { display:block; font-size:var(--font-size-small); color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:var(--space-1); }
.tag-list { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-1); padding-right:var(--space-2); }
.tag { max-width:100%; padding:var(--space-1) var(--space-2); min-height:0; color:var(--text-muted); background:var(--canvas); font-size:var(--font-size-small); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pagination { overflow:hidden; border-top:1px solid var(--border); }
.pagination > .pager { max-width:var(--page-width); margin:0 auto; padding:var(--space-3) var(--space-7); }
@container content (max-width: 600px) { .pagination > .pager { padding-inline:var(--space-5); } }
.empty { padding:var(--space-8) 0; text-align:center; }
.error { color:var(--danger); padding:var(--space-5) 0; }
@container content (max-width: 600px) { th:nth-child(3), .date { display:none; } .ideas-table th:nth-child(2) { width:110px; } .directory-grid { grid-template-columns:1fr; } .type-filters button { padding:var(--space-1) var(--space-2); } }
</style>
