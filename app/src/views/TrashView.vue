<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { TrashItem } from '@shared/types'
import { call, on } from '@/api'
import Pager from '@/components/Pager.vue'
import ObjectMenu from '@/components/ObjectMenu.vue'
import AppDialog from '@/components/AppDialog.vue'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
const items = ref<TrashItem[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const working = ref(false)
const purging = ref<string[]>([])
const error = ref('')
const dialogError = ref('')
const tabs = useTabsStore()
const toasts = useToastsStore()
let off: (() => void) | undefined
let sequence = 0
const actions = [
  { id: 'restore', label: t.actions.restore, testId: 'trash-menu-restore' },
  { id: 'copy', label: t.actions.originalPath, testId: 'trash-copy' },
  { id: 'purge', label: t.actions.purge, danger: true, separated: true, testId: 'trash-purge' },
]
async function load(next = page.value): Promise<void> {
  const mine = ++sequence
  page.value = next
  loading.value = true
  try {
    const result = await call('trash:list', { limit: 30, offset: (page.value - 1) * 30 })
    if (mine !== sequence) return
    total.value = result.total
    if (page.value > Math.max(1, Math.ceil(total.value / 30))) { void load(Math.max(1, Math.ceil(total.value / 30))); return }
    items.value = result.items
    error.value = ''
  } catch (e) { if (mine === sequence) error.value = (e as Error).message }
  finally { if (mine === sequence) loading.value = false }
}
async function restore(item: TrashItem): Promise<void> {
  if (working.value) return
  working.value = true
  try {
    if (item.kind === 'directory') {
      await call('folder:restore', { trashId: item.trashId })
      toasts.info(t.actions.restoredFolder)
    } else {
      const doc = await call('doc:restore', { trashId: item.trashId })
      toasts.info(t.actions.restored, { label: t.actions.open, run: () => tabs.open(doc.path, { newTab: true }) })
    }
    await load()
  } catch (e) { toasts.error((e as Error).message) }
  finally { working.value = false }
}
async function choose(item: TrashItem, action: string): Promise<void> {
  if (action === 'restore') { await restore(item); return }
  if (action === 'copy') {
    try { await navigator.clipboard.writeText(item.originalPath); toasts.info(t.actions.copied) }
    catch (e) { toasts.error((e as Error).message) }
  } else { dialogError.value = ''; purging.value = [item.trashId] }
}
async function empty(): Promise<void> {
  if (working.value) return
  working.value = true
  try {
    const ids = new Set<string>()
    for (let offset = 0; ; offset += 100) {
      const result = await call('trash:list', { limit: 100, offset })
      result.items.forEach((item) => ids.add(item.trashId))
      if (offset + result.items.length >= result.total || !result.items.length) break
    }
    dialogError.value = ''
    purging.value = [...ids]
  } catch (e) { toasts.error((e as Error).message) }
  finally { working.value = false }
}
async function purge(): Promise<void> {
  if (working.value) return
  working.value = true
  try {
    await call('trash:purge', { trashIds: [...purging.value] })
    await load()
    purging.value = []
  } catch (e) { dialogError.value = (e as Error).message }
  finally { working.value = false }
}
onMounted(() => { void load(); off = on('vault:changed', () => void load()) })
onUnmounted(() => { sequence++; off?.() })
</script>
<template>
  <div class="trash-view" data-testid="trash-view">
    <header><h1>{{ t.trash.title }}</h1><ObjectMenu :actions="[{ id: 'empty', label: t.actions.emptyTrash, danger: true, disabled: !total || working, testId: 'trash-empty-all' }]" trigger-id="trash-more" menu-id="trash-menu" @select="empty" /></header>
    <p class="small muted">{{ t.trash.intro }}</p>
    <p v-if="error" class="danger" role="alert">{{ error }} <button @click="load()">{{ t.common.retry }}</button></p>
    <p v-else-if="!items.length" class="empty muted" data-testid="trash-empty">{{ loading ? t.library.loading : t.trash.empty }}</p>
    <ul data-object-list :aria-busy="loading" :inert="working">
      <li v-for="item in items" :key="item.trashId" data-testid="trash-item" :data-path="item.originalPath" data-object-row>
        <div class="item-copy"><strong>{{ item.originalPath.split('/').pop() }}<span v-if="item.kind === 'directory'" class="small muted"> · {{ t.trash.folder }}</span></strong><p class="small muted selectable">{{ item.originalPath }}</p><p class="small faint">{{ new Date(item.deletedAt).toLocaleString('zh-CN') }}<span v-if="item.paths.length"> · {{ t.trash.files(item.paths.length) }}</span></p><details v-if="item.paths.length > 1" class="small muted"><summary>{{ t.trash.scope }}</summary><p v-for="path in item.paths" :key="path" class="selectable">{{ path }}</p></details></div>
        <button :disabled="loading || working" data-testid="trash-restore" @click="restore(item)">{{ t.actions.restore }}</button>
        <ObjectMenu :actions trigger-id="trash-item-more" menu-id="trash-item-menu" @select="choose(item, $event)" />
      </li>
    </ul>
    <Pager :page :total :size="30" prefix="trash" :disabled="loading || working" @change="load" />
    <AppDialog v-if="purging.length" :title="t.actions.purge" :busy="working" @close="purging = []"><form @submit.prevent="purge"><p>{{ t.actions.purgeHint(purging.length) }}</p><p v-if="dialogError" class="dialog-error" role="alert">{{ dialogError }}</p><div class="dialog-actions"><button type="button" :disabled="working" @click="purging = []">{{ t.actions.cancel }}</button><button class="primary" :disabled="working" data-testid="trash-purge-confirm">{{ t.actions.purge }}</button></div></form></AppDialog>
  </div>
</template>
<style scoped>
.trash-view { height:100%; overflow:auto; padding:var(--space-6) var(--space-7); }
header { display:flex; align-items:center; justify-content:space-between; }
h1 { font-size:var(--font-size-title); margin:0; font-weight:650; }
ul { list-style:none; padding:0; }
li { display:flex; gap:var(--space-3); align-items:center; padding:var(--space-4) 0; border-bottom:1px solid var(--border); }
.item-copy { flex:1; min-width:0; overflow-wrap:anywhere; }
li p { margin:var(--space-1) 0; }
strong { font-weight:500; }
.empty { padding:var(--space-8) 0; text-align:center; }
.danger { color:var(--danger); }
</style>
