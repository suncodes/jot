<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { LibraryItem } from '@shared/types'
import { invoke, on } from '@/api'
import DocView from '@/views/DocView.vue'
import FileView from '@/views/FileView.vue'
import type { Tab } from '@/stores/tabs'
const { tab, active } = defineProps<{ tab: Tab; active: boolean }>()
const item = ref<LibraryItem | null>(null)
const loaded = ref(false)
let tick = 0
const offs: (() => void)[] = []
async function load(): Promise<void> {
  const request = ++tick
  const r = await invoke('library:resolve', { path: tab.path })
  if (request !== tick) return
  if (r.ok) {
    // 原件暂时缺失时保留详情容器，内嵌编辑器负责提示并保留草稿。
    item.value = r.data ?? (item.value?.kind === 'file' ? { ...item.value, path: tab.path, sourceMissing: true } : null)
  }
  loaded.value = true
}
watch(() => tab.path, () => { void load() })
onMounted(() => { void load(); offs.push(on('files:changed', () => void load()), on('doc:updated', () => void load()), on('vault:changed', () => void load())) })
onUnmounted(() => { tick++; offs.forEach((off) => off()) })
</script>
<template>
  <FileView v-if="loaded && item?.kind === 'file'" :tab :active :item />
  <DocView v-else-if="loaded" :tab :active />
</template>
