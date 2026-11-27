<script setup lang="ts">
import { ref } from 'vue'
import { X } from 'lucide-vue-next'
import { useTabsStore } from '@/stores/tabs'
import ObjectMenu from './ObjectMenu.vue'

const tabs = useTabsStore()
const dragFrom = ref<number | null>(null)
function actions(index: number) {
  return [
    { id: 'close', disabled: tabs.batchClosing, label: '关闭当前标签页', testId: 'tab-menu-close' },
    { id: 'others', label: '关闭其他标签页', disabled: tabs.tabs.length < 2 || tabs.batchClosing, testId: 'tab-menu-others' },
    { id: 'left', label: '关闭左侧标签页', disabled: index === 0 || tabs.batchClosing, testId: 'tab-menu-left' },
    { id: 'right', label: '关闭右侧标签页', disabled: index === tabs.tabs.length - 1 || tabs.batchClosing, testId: 'tab-menu-right' },
  ]
}
function select(path: string, action: string): void {
  if (action === 'close') void tabs.close(path)
  else if (action === 'others' || action === 'left' || action === 'right') void tabs.closeRelative(path, action)
}
</script>
<template>
  <div v-for="(tab, index) in tabs.tabs" :key="tab.key" class="tab" :class="{ active: tab.path === tabs.activePath }" data-object-row data-testid="tab" :data-path="tab.path" draggable="true" @click="tabs.activePath = tab.path" @auxclick.middle="tabs.close(tab.path)" @dragstart="dragFrom = index" @dragend="dragFrom = null" @dragover.prevent @drop="dragFrom !== null && tabs.move(dragFrom, index)">
    <button class="ghost tab-title" @click="tabs.activePath = tab.path">{{ tab.title }}</button>
    <ObjectMenu class="tab-close" :actions="actions(index)" primary-action="close" label="标签页操作" trigger-id="tab-close" menu-id="tab-menu" @select="select(tab.path, $event)"><X :size="12" /></ObjectMenu>
  </div>
</template>
<style scoped>
.tab { display:flex; flex:none; align-items:center; height:30px; max-width:190px; padding:0 var(--space-1); border-radius:var(--radius-s); color:var(--text-muted); }
.tab.active { color:var(--accent); background:var(--accent-soft); }
.tab-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 var(--space-2); font-size:var(--font-size-small); color:inherit; }
.tab-close { display:grid; place-items:center; padding:2px; min-height:0; color:var(--text-faint); }
</style>
