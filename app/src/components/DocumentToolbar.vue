<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next'
import ContentActions from './ContentActions.vue'
import ContentBreadcrumb from './ContentBreadcrumb.vue'
import { LIBRARY_TAB, useTabsStore } from '@/stores/tabs'
import { t } from '@/strings'

defineProps<{ path: string; embedded?: boolean }>()
const tabs = useTabsStore()
</script>

<template>
  <div class="document-toolbar" data-testid="document-toolbar">
    <div class="toolbar-row">
      <button v-if="!embedded" type="button" class="ghost toolbar-back" :title="t.library.back" :aria-label="t.library.back" data-testid="detail-back" @click="tabs.open(LIBRARY_TAB, { newTab: true, title: t.library.title })"><ArrowLeft :size="14" aria-hidden="true" /><span class="toolbar-label">{{ t.library.back }}</span></button>
      <ContentBreadcrumb v-if="!embedded" class="toolbar-breadcrumb" :path :title="path" />
      <span class="toolbar-space" />
      <div class="toolbar-actions"><slot /><ContentActions v-if="!embedded" :path /></div>
    </div>
  </div>
</template>

<style scoped>
.document-toolbar { container:document-toolbar / inline-size; flex:none; min-width:0; }
.toolbar-row { display:flex; align-items:center; gap:var(--space-3); min-width:0; }
.toolbar-back, :deep(.document-tool) { display:inline-flex; align-items:center; justify-content:center; flex:none; gap:var(--space-2); min-height:32px; padding:var(--space-1) var(--space-2); color:var(--text-muted); font-size:var(--font-size-small); white-space:nowrap; }
.toolbar-back > svg, :deep(.document-tool > svg) { flex:none; }
.toolbar-breadcrumb { flex:0 1 auto; flex-wrap:nowrap; min-width:0; overflow:hidden; white-space:nowrap; }
:deep(.toolbar-breadcrumb button) { white-space:nowrap; }
.toolbar-space { flex:1; }
.toolbar-actions { display:flex; align-items:center; flex:none; gap:var(--space-2); }
.toolbar-actions > :deep(*) { flex-shrink:0; }
:deep(.document-tool[aria-pressed='true']) { color:var(--accent); background:var(--accent-soft); }
@container document-toolbar (max-width:680px) {
  .toolbar-breadcrumb { display:none; }
}
@container document-toolbar (max-width:520px) {
  :deep(.toolbar-label) { display:none; }
  .toolbar-row { gap:var(--space-2); }
  .toolbar-actions { gap:var(--space-1); }
  .toolbar-back, :deep(.document-tool) { width:32px; padding:0; }
}
</style>
