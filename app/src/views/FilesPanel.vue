<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { TreeNode } from '@shared/types'
import { call, on } from '@/api'
import FileTree from '@/components/FileTree.vue'
import FolderActions from '@/components/FolderActions.vue'
import { folderArea } from '@/utils/objectActions'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
const tabs = useTabsStore()
const toasts = useToastsStore()
const nodes = ref<TreeNode[]>([])
const currentDir = ref('content')
const creation = ref<InstanceType<typeof FolderActions> | null>(null)
let off: (() => void) | undefined
let sequence = 0
async function refresh(): Promise<void> {
  const mine = ++sequence
  try {
    const tree = await call('vault:tree', {})
    if (mine !== sequence) return
    nodes.value = tree
    const contains = (items: TreeNode[]): boolean => items.some((n) => n.kind === 'dir' && (n.path === currentDir.value || contains(n.children ?? [])))
    if (!contains(tree)) currentDir.value = 'content'
  } catch (e) { toasts.error((e as Error).message) }
}
async function newNote(): Promise<void> {
  const meta = await call('doc:create', { dir: currentDir.value !== 'content' && folderArea(currentDir.value) ? currentDir.value : undefined, title: t.files.newNoteTitle })
  await tabs.open(meta.path, { newTab: true, startEditing: true })
}
onMounted(() => { void refresh(); off = on('vault:changed', () => void refresh()) })
onUnmounted(() => { sequence++; off?.() })
defineExpose({ newNote })
</script>
<template>
  <div class="files" data-testid="files-panel">
    <div class="toolbar"><span class="small muted">{{ t.library.storage }}</span><FolderActions ref="creation" :path="folderArea(currentDir) ? currentDir : 'content'" create-only /></div>
    <div class="scroll" @contextmenu.self.prevent="creation?.open($event)"><FileTree :nodes :depth="0" :active-path="tabs.activePath" :current-dir @open="(path, newTab) => tabs.open(path, { newTab })" @select="currentDir = $event" /></div>
  </div>
</template>
<style scoped>
.files { flex:1; min-height:0; display:flex; flex-direction:column; }
.toolbar { display:flex; align-items:center; justify-content:space-between; padding:var(--space-1) var(--space-3); }
.scroll { flex:1; overflow:auto; padding:0 var(--space-1) var(--space-2); }
</style>
