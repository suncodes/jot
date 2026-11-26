<script setup lang="ts">
import { ChevronsDownUp, ChevronsUpDown, Inbox, Layers, Lightbulb, LocateFixed, Tags } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { on } from '@/api'
import { useLibraryStore } from '@/stores/library'
import { useAppStore } from '@/stores/app'
import { TAXONOMY_TAB, useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import FolderActions from '@/components/FolderActions.vue'
import LibraryDirectory from '@/components/LibraryDirectory.vue'
import LibraryPins from '@/components/LibraryPins.vue'
import { t } from '@/strings'

const emit = defineEmits<{ import: [files: File[], directoryPath: string] }>()
const library = useLibraryStore()
const tabs = useTabsStore()
const toasts = useToastsStore()
const nav = ref<HTMLElement | null>(null)
const located = ref('')
const target = computed(() => library.locationFor(tabs.activePath))
const collapsed = computed(() => library.branchExpanded())
const expandLabel = computed(() => collapsed.value ? t.directory.collapseAll : t.directory.expandAll)
let timer: ReturnType<typeof setTimeout> | undefined
let highlightTimer: ReturnType<typeof setTimeout> | undefined
const offs: (() => void)[] = []
function refresh(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void library.refresh().catch((e: Error) => toasts.error(e.message)), 100)
}
async function locate(): Promise<void> {
  const destination = target.value
  if (!destination) return
  if (destination.directoryPath) library.revealDirectory(destination.directoryPath)
  const key = destination.directoryPath ?? destination.collection!
  located.value = key
  clearTimeout(highlightTimer)
  await nextTick()
  const element = destination.directoryPath
    ? [...(nav.value?.querySelectorAll<HTMLElement>('[data-directory-path]') ?? [])].find(row => row.dataset.directoryPath === key)
    : nav.value?.querySelector<HTMLElement>('[data-testid="library-' + key + '"]')
  element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  highlightTimer = setTimeout(() => { located.value = '' }, 1600)
}
watch(() => useAppStore().vault.path, refresh)
onMounted(() => {
  refresh()
  offs.push(on('vault:changed', refresh), on('storage:changed', refresh))
})
onUnmounted(() => { clearTimeout(timer); clearTimeout(highlightTimer); offs.forEach(off => off()) })
</script>

<template>
  <div class="library-side" data-testid="library-sidebar">
    <header><strong>{{ t.library.title }}</strong></header>
    <nav ref="nav" class="categories" data-object-list :aria-label="t.library.title">
      <button class="shortcut ghost" :class="{ selected: library.scope.collection === 'all', located: located === 'all' }" :aria-current="library.scope.collection === 'all' ? 'page' : undefined" data-testid="library-all" @click="library.select({ collection: 'all' })"><Layers :size="15" />{{ t.library.all }}</button>
      <button class="shortcut ghost" :class="{ selected: library.scope.collection === 'ideas', located: located === 'ideas' }" :aria-current="library.scope.collection === 'ideas' ? 'page' : undefined" data-testid="library-ideas" @click="library.select({ collection: 'ideas' })"><Lightbulb :size="15" />{{ t.library.ideas }}</button>
      <button class="shortcut ghost" :class="{ selected: library.scope.collection === 'pending', located: located === 'pending' }" :aria-current="library.scope.collection === 'pending' ? 'page' : undefined" data-testid="library-pending" @click="library.select({ collection: 'pending' })"><Inbox :size="15" />{{ t.library.pending }}</button>
      <LibraryPins />
      <section class="library-group" :aria-label="t.directory.sectionTitle">
        <div class="library-group-heading">
          <h2>{{ t.directory.sectionTitle }}</h2>
          <div class="directory-controls">
            <button class="ghost icon-button" :title="target ? t.directory.locate : t.directory.cannotLocate" :aria-label="t.directory.locate" :disabled="!target" data-testid="library-locate" @click="locate"><LocateFixed :size="14" /></button>
            <button class="ghost icon-button" :title="expandLabel" :aria-label="expandLabel" :disabled="!library.canExpand" data-testid="library-expand-all" @click="library.toggleBranch()"><ChevronsDownUp v-if="collapsed" :size="14" /><ChevronsUpDown v-else :size="14" /></button>
            <FolderActions path="content" :label="t.library.createAtRoot" create-only />
          </div>
        </div>
        <ul><LibraryDirectory v-for="directory in library.roots" :key="directory.path" :directory :located-path="located" @import="(files, id) => emit('import', files, id)" /></ul>
      </section>
    </nav>
    <footer><button class="ghost" data-testid="projects-manage" @click="tabs.open(TAXONOMY_TAB, { newTab: true, title: t.taxonomy.title })"><Tags :size="14" />{{ t.library.manage }}</button></footer>
  </div>
</template>

<style scoped>
.library-side { display:flex; flex-direction:column; height:100%; min-height:0; padding:var(--space-4) var(--space-2) 0; }
header { padding:0 var(--space-3) var(--space-3); font-size:var(--font-size-small); }
.categories { flex:1; overflow:auto; }
ul { padding:0; margin:0; list-style:none; }
/* 固定和内容目录共用分组层级，与上方的逻辑入口拉开间距。 */
.library-group { margin-top:var(--space-5); }
.library-side :deep(.library-group-heading) { display:flex; align-items:center; justify-content:space-between; gap:var(--space-1); min-height:var(--space-6); margin:0 var(--space-3) var(--space-2); }
.library-side :deep(.library-group-heading h2) { margin:0; color:var(--text-normal); font-size:var(--font-size-ui); font-weight:600; white-space:nowrap; }
.directory-controls { display:flex; align-items:center; flex:none; gap:2px; }
.directory-controls .icon-button, .directory-controls :deep(.object-more) { width:24px; height:28px; padding:0; color:var(--text-muted); }
.shortcut { display:flex; align-items:center; gap:var(--space-2); width:100%; padding:var(--space-2) var(--space-3); margin-bottom:var(--space-1); text-align:left; color:inherit; }
.selected, .selected:hover { color:var(--accent); background:var(--accent-soft); }
.located { scroll-margin-block:var(--space-2); box-shadow:inset 0 0 0 1px var(--accent); background:var(--accent-soft); }
footer { border-top:1px solid var(--border); margin-top:var(--space-4); padding:var(--space-3) var(--space-1); }
footer button { display:flex; align-items:center; gap:var(--space-2); color:var(--text-muted); font-size:var(--font-size-small); }
</style>
