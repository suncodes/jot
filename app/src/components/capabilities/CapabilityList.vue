<script setup lang="ts">
import { ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'
import ObjectMenu from '@/components/ObjectMenu.vue'
import type { CapabilityPage } from '@/capabilities/model'
import type { CapabilityRow } from '@/capabilities/presentation'
import type { MenuAction } from '@/utils/objectActions'
import { t } from '@/strings'
const { page, rows, selected, menus, narrowed = false } = defineProps<{ page: CapabilityPage; rows: CapabilityRow[]; selected: string; menus: (id: string) => MenuAction[]; narrowed?: boolean }>()
const emit = defineEmits<{ choose: [id: string, enter: boolean]; action: [action: string, id: string]; clear: [] }>()
const c = t.capabilities
const list = ref<HTMLElement | null>(null)
const scroll = new Map<CapabilityPage, number>()
function focus(id: string): void {
  list.value?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(id)}"] .row-main`)?.focus()
}
function key(e: KeyboardEvent): void {
  if (e.isComposing || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || !(e.target as Element).matches('.row-main')) return
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id
  const index = rows.findIndex(row => row.id === id)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowUp' ? -1 : 1)))
  e.preventDefault()
  const row = rows[next]
  if (row) { emit('choose', row.id, false); focus(row.id) }
}
watch(() => page, (value, old) => {
  if (!list.value) return
  scroll.set(old, list.value.scrollTop)
  list.value.scrollTop = scroll.get(value) ?? 0
}, { flush: 'post' })
defineExpose({ focus })
</script>
<template>
  <div class="cap-list-caption"><span>{{ page === 'runs' ? c.listTask : c.listName }}</span><span>{{ c.listStatus }}</span></div>
  <div ref="list" class="cap-list" data-object-list data-testid="cap-list" @keydown="key">
    <div v-for="row in rows" :key="row.id" class="cap-row" :class="{ selected: row.id === selected, 'run-row': page === 'runs' }" :data-id="row.id" data-object-row>
      <button class="ghost row-main" :aria-current="row.id === selected ? 'true' : undefined" :tabindex="row.id === selected ? 0 : -1" :title="row.title" :data-testid="'cap-row-' + row.id" @click="emit('choose', row.id, true)"><component :is="row.icon" :size="17" /><span class="cap-row-name">{{ row.title }}<small v-if="row.subtitle" :title="row.subtitle">{{ row.subtitle }}</small></span></button>
      <span class="row-state" :class="row.tone" :title="row.status"><span v-if="row.tone !== 'muted'" class="cap-dot" />{{ row.status }}</span>
      <div class="row-menu"><ObjectMenu :actions="menus(row.id)" :label="c.moreDetails" :trigger-id="'cap-more-' + row.id" @select="emit('action', $event, row.id)" /></div>
    </div>
    <div v-if="!rows.length" class="cap-empty" data-testid="cap-empty"><Search :size="27" /><h3>{{ page === 'runs' && !narrowed ? c.noRuns : c.emptyTitle }}</h3><p>{{ page === 'runs' && !narrowed ? c.noRunsHint : c.emptyHint }}</p><button v-if="narrowed" @click="emit('clear')">{{ c.clearFilters }}</button></div>
  </div>
  <slot name="pager" />
  <div class="cap-list-foot">{{ page === 'tools' ? c.toolListHint : page === 'runs' ? c.runListHint : c.listHint }}</div>
</template>
