<script setup lang="ts">
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import { reactive } from 'vue'
import type { TreeNode } from '@shared/types'
import FolderActions from '@/components/FolderActions.vue'
import ContentActions from '@/components/ContentActions.vue'
import { t } from '@/strings'

defineProps<{ nodes: TreeNode[]; depth: number; activePath: string | null; currentDir: string }>()
const emit = defineEmits<{ open: [path: string, newTab: boolean]; select: [dir: string] }>()
const collapsed = reactive(new Set<string>())
function open(node: TreeNode, newTab = false): void {
  if (node.kind === 'dir') {
    emit('select', node.path)
    if (collapsed.has(node.path)) collapsed.delete(node.path)
    else collapsed.add(node.path)
  } else { emit('select', node.path.split('/').slice(0, -1).join('/')); emit('open', node.path, newTab) }
}
</script>
<template>
  <ul class="tree" data-object-list>
    <li v-for="node in nodes" :key="node.path">
      <div class="row" :class="{ active: node.path === activePath || node.kind === 'dir' && node.path === currentDir }" :style="{ paddingLeft: 8 + depth * 14 + 'px' }" :data-testid="`tree-${node.path}`" data-object-row tabindex="0" :aria-label="node.name" @click="open(node, $event.ctrlKey)" @keydown.self.enter.prevent="open(node)" @keydown.self.space.prevent="open(node)" @auxclick.middle="node.kind === 'file' && emit('open', node.path, true)">
        <span class="twisty"><template v-if="node.kind === 'dir'"><ChevronRight v-if="collapsed.has(node.path)" :size="14" /><ChevronDown v-else :size="14" /></template></span>
        <span class="name" :class="{ dir: node.kind === 'dir' }">{{ node.kind === 'file' ? node.name.replace(/\.(md|markdown)$/i, '') : node.name }}</span>
        <FolderActions v-if="node.kind === 'dir'" :path="node.path" /><ContentActions v-else :path="node.path" />
      </div>
      <template v-if="node.kind === 'dir' && !collapsed.has(node.path)">
        <FileTree v-if="node.children?.length" :nodes="node.children" :depth="depth + 1" :active-path :current-dir @open="(p, n) => emit('open', p, n)" @select="emit('select', $event)" />
        <div v-else class="empty small faint" :style="{ paddingLeft: 30 + depth * 14 + 'px' }">{{ t.empty.folder }}</div>
      </template>
    </li>
  </ul>
</template>
<style scoped>
.tree { list-style:none; margin:0; padding:0; }
.row { display:flex; align-items:center; gap:2px; min-height:30px; padding-right:var(--space-1); border-radius:var(--radius-s); font-size:var(--font-size-small); color:var(--text-muted); cursor:pointer; }
.row:hover { background:var(--bg-hover); }
.row.active { background:var(--bg-active); color:var(--text-normal); }
.twisty { width:16px; flex:none; display:grid; place-items:center; }
.name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.name.dir { color:var(--text-normal); font-weight:500; }
.empty { height:24px; line-height:24px; }
</style>
