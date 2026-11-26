<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { DocMeta } from '@shared/types'
import { call, on } from '@/api'
import { useTabsStore } from '@/stores/tabs'
import { t } from '@/strings'

// 按名称快速打开文件（Ctrl+O）
const emit = defineEmits<{ close: [] }>()
const tabs = useTabsStore()
const query = ref('')
const items = ref<DocMeta[]>([])
const index = ref(0)
const input = ref<HTMLInputElement | null>(null)
let seq = 0

async function run(): Promise<void> {
  const mine = ++seq
  const r = await call('doc:quickOpen', { query: query.value, limit: 20 })
  if (mine !== seq) return
  items.value = r
  index.value = 0
}
watch(query, () => void run())

function choose(doc: DocMeta | undefined, newTab = false): void {
  if (!doc) return
  tabs.open(doc.path, { newTab, title: doc.title })
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') index.value = Math.min(index.value + 1, items.value.length - 1)
  else if (e.key === 'ArrowUp') index.value = Math.max(index.value - 1, 0)
  else if (e.key === 'Enter') choose(items.value[index.value], e.ctrlKey)
  else if (e.key === 'Escape') emit('close')
  else return
  e.preventDefault()
}

// 打开期间库里有变化（比如刚在外部新建了文件）就重新查一次
let off: (() => void) | undefined
onMounted(() => {
  input.value?.focus()
  void run()
  off = on('vault:changed', () => void run())
})
onUnmounted(() => off?.())
</script>

<template>
  <div class="overlay" data-testid="quick-open" @mousedown.self="emit('close')">
    <div class="panel">
      <input ref="input" v-model="query" type="text" data-testid="quick-open-input" :placeholder="t.quickOpen.placeholder" @keydown="onKeydown" />
      <ul>
        <li
          v-for="(doc, i) in items"
          :key="doc.path"
          :class="{ active: i === index }"
          data-testid="quick-open-item"
          @mouseenter="index = i"
          @click="choose(doc, $event.ctrlKey)"
        >
          <span class="title">{{ doc.title }}</span>
          <span class="path small faint">{{ doc.path }}</span>
        </li>
        <li v-if="!items.length" class="none small faint">{{ t.quickOpen.none }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  background: rgb(0 0 0 / 0.25);
}
.panel {
  width: 560px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow);
  overflow: hidden;
}
input {
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  padding: var(--space-3);
  font-size: var(--font-size-text);
}
ul {
  list-style: none;
  margin: 0;
  padding: var(--space-1);
  overflow: auto;
}
li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-s);
  cursor: pointer;
}
li.active {
  background: var(--bg-active);
}
.title,
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path {
  flex: none;
  max-width: 55%;
}
.none {
  cursor: default;
}
</style>
