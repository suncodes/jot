<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import ObjectMenu from '@/components/ObjectMenu.vue'
import type { MenuAction } from '@/utils/objectActions'
import { t } from '@/strings'

const { name, count, candidate, selected } = defineProps<{
  name: string; count: number; candidate: boolean; selected: boolean
}>()
const emit = defineEmits<{ toggle: []; rename: [to: string]; remove: [] }>()
const row = useTemplateRef<HTMLElement>('row')
const input = useTemplateRef<HTMLInputElement>('input')
const renaming = ref(false)
const draft = ref('')
const actions = computed<MenuAction[]>(() => [
  { id: 'rename', label: t.taxonomy.rename, testId: 'taxonomy-rename' },
  { id: 'remove', label: t.taxonomy.removeAssignment, danger: true, separated: true, testId: 'taxonomy-remove' },
])
function focusRow(): void { void nextTick(() => row.value?.focus({ preventScroll: true })) }
async function choose(action: string): Promise<void> {
  if (action === 'rename') {
    draft.value = name
    renaming.value = true
    await nextTick()
    input.value?.select()
  } else if (action === 'remove') emit('remove')
}
function finishRename(e: Event): void {
  if (!renaming.value || (e instanceof KeyboardEvent && e.isComposing)) return
  if (e instanceof KeyboardEvent) e.preventDefault()
  renaming.value = false
  const to = draft.value.trim()
  if (to && to !== name) emit('rename', to)
  if (e.type === 'keydown') focusRow()
}
function cancelRename(e: KeyboardEvent): void {
  if (e.isComposing) return
  renaming.value = false
  focusRow()
}
</script>

<template>
  <li ref="row" class="taxonomy-row" :class="{ selected }" tabindex="0" data-object-row data-testid="taxonomy-row" :data-name="name">
    <input class="check" type="checkbox" :checked="selected" :aria-label="t.taxonomy.select(name)" data-testid="taxonomy-check" @change="emit('toggle')" />
    <div class="name-cell">
      <input v-if="renaming" ref="input" v-model="draft" class="rename" type="text" :aria-label="t.taxonomy.rename" data-testid="taxonomy-rename-input"
        @keydown.enter="finishRename" @keydown.esc.stop="cancelRename" @blur="finishRename" />
      <span v-else class="name" :title="name" data-testid="taxonomy-name">{{ name }}</span>
      <span v-if="candidate" class="candidate" :title="t.taxonomy.candidateHint" data-testid="taxonomy-candidate">{{ t.taxonomy.candidate }}</span>
    </div>
    <span class="count muted" data-testid="taxonomy-count">{{ t.taxonomy.count(count) }}</span>
    <div class="menu-cell"><ObjectMenu :actions :label="t.taxonomy.actionsFor(name)" trigger-id="taxonomy-more" menu-id="taxonomy-menu" @select="choose" /></div>
  </li>
</template>

<style scoped>
.taxonomy-row {
  display: grid;
  grid-template-columns: var(--taxonomy-columns);
  align-items: center;
  gap: var(--space-3);
  min-height: var(--taxonomy-row-height);
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--border);
}
.taxonomy-row:hover { background: var(--bg-hover); }
.taxonomy-row.selected { background: var(--accent-soft); }
.taxonomy-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--radius-s); }
.check { width: var(--space-4); height: var(--space-4); margin: 0; accent-color: var(--accent); cursor: pointer; }
.name-cell { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { min-width: 0; }
.rename { width: 100%; min-width: 0; height: var(--taxonomy-menu-size); font-size: inherit; }
.candidate { flex: none; padding: 0 var(--space-1); border-radius: var(--radius-s); background: var(--bg-active); color: var(--text-muted); font-size: 11px; }
.count { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.menu-cell { display: flex; align-items: center; }
.menu-cell :deep(.object-more) { width: var(--taxonomy-menu-size); height: var(--taxonomy-menu-size); padding: 0; color: var(--text-faint); }
</style>
