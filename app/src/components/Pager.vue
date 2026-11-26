<script setup lang="ts">
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { computed } from 'vue'
import { t } from '@/strings'

const { page, total, size, prefix, disabled = false } = defineProps<{ page: number; total: number; size: number; prefix: string; disabled?: boolean }>()
const emit = defineEmits<{ change: [page: number] }>()
const pages = computed(() => Math.max(1, Math.ceil(total / size)))
</script>

<template>
  <footer class="pager small">
    <span class="muted" :data-testid="prefix + '-page'">{{ t.library.page(page, pages) }}</span>
    <div><button type="button" class="icon-button" :data-testid="prefix + '-prev'" :aria-label="t.common.previous" :disabled="disabled || page <= 1" @click="emit('change', page - 1)"><ChevronLeft :size="15" /></button><button type="button" class="icon-button" :data-testid="prefix + '-next'" :aria-label="t.common.next" :disabled="disabled || page >= pages" @click="emit('change', page + 1)"><ChevronRight :size="15" /></button></div>
  </footer>
</template>

<style scoped>
.pager { display:flex; flex:none; align-items:center; justify-content:space-between; gap:var(--space-3); padding:var(--space-3) 0; }
.pager > div { display:flex; gap:var(--space-2); }
</style>
