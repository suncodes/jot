<script setup lang="ts">
import { SlidersHorizontal } from 'lucide-vue-next'
import { computed } from 'vue'
import type { Doc } from '@shared/types'
import { t } from '@/strings'

const open = defineModel<boolean>({ required: true })
const { panelId, doc } = defineProps<{ panelId: string; doc: Doc }>()
const tooltip = computed(() => [
  open.value ? t.props.collapseProperties : t.props.expand,
  doc.occurredAt,
  ...doc.classification.tags.map(tag => '#' + tag),
  doc.classification.place,
  ...doc.classification.people.map(person => '@' + person),
].filter(Boolean).join(' · '))
</script>

<template>
  <button type="button" class="property-button" :class="{ open }" :title="tooltip" :aria-label="open ? t.props.collapseProperties : t.props.expand" :aria-expanded="open" :aria-controls="open ? panelId : undefined" data-testid="props-summary" @click="open = !open"><SlidersHorizontal :size="14" aria-hidden="true" /><span>{{ t.props.title }}</span></button>
</template>

<style scoped>
.property-button { display:inline-flex; align-items:center; justify-content:center; flex:none; gap:var(--space-2); min-height:32px; padding:var(--space-1) var(--space-3); color:var(--text-muted); background:transparent; font-size:var(--font-size-small); white-space:nowrap; }
.property-button > svg { flex:none; }
.property-button.open { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); }
</style>
