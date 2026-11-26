<script setup lang="ts">
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Folder } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { DirectoryItem } from '@shared/files'
import { useLibraryStore } from '@/stores/library'
import FolderActions from './FolderActions.vue'
import { t } from '@/strings'

const { directory, locatedPath = '' } = defineProps<{ directory: DirectoryItem; locatedPath?: string }>()
const emit = defineEmits<{ import: [files: File[], directoryPath: string] }>()
const library = useLibraryStore()
const dropping = ref(false)
const branchExpanded = computed(() => library.branchExpanded(directory.path))
const branchLabel = computed(() => branchExpanded.value ? t.directory.collapseBranch(directory.name) : t.directory.expandBranch(directory.name))
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
function drop(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault(); e.stopPropagation(); dropping.value = false
  emit('import', [...(e.dataTransfer?.files ?? [])], directory.path)
}
</script>
<template>
  <li>
    <div class="tree-row" :class="{ selected: library.scope.directoryPath === directory.path, dropping, located: locatedPath === directory.path }" data-object-row :data-directory-path="directory.path" :data-path="directory.path" @dragover="hasFiles($event) && ($event.preventDefault(), dropping = true)" @dragleave="dropping = false" @drop="drop">
      <button class="ghost toggle" :class="{ leaf: !directory.hasChildren }" :disabled="!directory.hasChildren" :aria-label="t.library.expand(directory.name)" :aria-expanded="directory.hasChildren ? library.expanded.has(directory.path) : undefined" data-testid="library-toggle" @click="library.toggle(directory.path)" @keydown.right.prevent="!library.expanded.has(directory.path) && library.toggle(directory.path)" @keydown.left.prevent="library.expanded.has(directory.path) && library.toggle(directory.path)"><ChevronRight :size="13" /></button>
      <button class="ghost tree-label" data-testid="library-directory" :title="directory.path.slice(8)" :aria-current="library.scope.directoryPath === directory.path ? 'page' : undefined" @click="library.select({ directoryPath: directory.path })"><Folder :size="15" /><span>{{ directory.name }}</span></button>
      <button v-if="directory.hasChildren" class="ghost branch-toggle" :title="branchLabel" :aria-label="branchLabel" data-testid="library-branch-toggle" @click="library.toggleBranch(directory.path)"><ChevronsDownUp v-if="branchExpanded" :size="13" /><ChevronsUpDown v-else :size="13" /></button>
      <FolderActions :path="directory.path" />
    </div>
    <ul v-if="library.expanded.has(directory.path)">
      <LibraryDirectory v-for="child in library.directories[directory.path] ?? []" :key="child.path" :directory="child" :located-path @import="(files, id) => emit('import', files, id)" />
    </ul>
  </li>
</template>
<style scoped>
ul { padding:0 0 0 var(--space-4); margin:0; list-style:none; }
.tree-row { display:flex; align-items:center; min-width:0; margin-bottom:var(--space-1); border-radius:var(--radius-s); color:var(--text-muted); }
.tree-label { display:flex; align-items:center; gap:var(--space-2); flex:1; min-width:0; padding:var(--space-2) var(--space-1); overflow:hidden; text-align:left; color:inherit; }
.tree-label span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tree-label svg { flex:none; }
.toggle { flex:none; width:24px; display:grid; place-items:center; padding:var(--space-1); margin-left:var(--space-1); color:inherit; }
.toggle[aria-expanded='true'] svg { transform:rotate(90deg); }
.toggle.leaf { visibility:hidden; }
.branch-toggle { display:grid; place-items:center; flex:none; width:22px; height:28px; padding:0; opacity:0; color:inherit; }
.tree-row :deep(.object-more) { width:24px; height:28px; padding:0; }
.tree-row:hover .branch-toggle, .tree-row:focus-within .branch-toggle, .tree-row[data-menu-open] .branch-toggle { opacity:1; }
.selected, .selected:hover, .dropping { color:var(--accent); background:var(--accent-soft); }
.located { scroll-margin-block:var(--space-2); box-shadow:inset 0 0 0 1px var(--accent); background:var(--accent-soft); }
@media (hover:none) { .branch-toggle { opacity:1; } }
</style>
