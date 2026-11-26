<script setup lang="ts">
import { ChevronRight, FolderOpen } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import type { Doc } from '@shared/types'
import { contentArea } from '@shared/storage'
import { call } from '@/api'
import { prepareContentAction } from '@/utils/pendingEdits'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import { useToastsStore } from '@/stores/toasts'
import ContentDirectorySelect from './ContentDirectorySelect.vue'
import { t } from '@/strings'

const { doc } = defineProps<{ doc: Doc }>()
const changing = ref(false)
const target = ref('root')
const busy = ref(false)
const path = computed(() => !doc.sourceMissing && doc.sourcePath ? doc.sourcePath : doc.path)
const area = computed(() => contentArea(path.value))
const parent = computed(() => path.value.split('/').slice(0, -1).join('/'))
const directoryLabel = computed(() => {
  if (area.value === 'ideas') return t.directory.ideasPosition
  if (area.value === 'inbox') return t.directory.pendingPosition
  if (area.value === 'content') return parent.value === 'content' ? t.directory.root : parent.value.slice('content/'.length).split('/').join(' / ')
  return doc.type === 'daily' ? t.directory.dailyPosition : parent.value || path.value
})
function browse(): void {
  if (area.value === 'ideas' || area.value === 'inbox') {
    useLibraryStore().select({ collection: area.value === 'ideas' ? 'ideas' : 'pending' })
  } else if (area.value === 'content') {
    useLibraryStore().select(parent.value === 'content' ? { collection: 'all' } : { directoryPath: parent.value })
  }
}
async function move(): Promise<void> {
  busy.value = true
  try {
    const before = path.value
    await prepareContentAction(before)
    const meta = await call('doc:move', { ref: { path: before }, toDir: target.value === 'root' ? 'content' : target.value })
    useTabsStore().retarget(before, meta.path)
    if (meta.notUpdated?.length) useToastsStore().error(t.library.linksNotUpdated + meta.notUpdated.map(item => item.path).join('、'))
    changing.value = false
  } catch (e) { useToastsStore().error((e as Error).message) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="position" data-testid="props-position">
    <div class="position-value">
      <button type="button" class="ghost location-link" :disabled="!area" :title="path" @click="browse">
        <FolderOpen :size="14" aria-hidden="true" />
        <span>{{ directoryLabel }}</span>
      </button>
      <button v-if="!doc.sourceMissing && ['note', 'record', 'source'].includes(doc.role ?? '')" type="button" class="ghost move-link" :disabled="busy" :aria-expanded="changing" data-testid="props-move" @click="changing = !changing">
        {{ changing ? t.common.cancel : t.props.move }}<ChevronRight v-if="!changing" :size="13" aria-hidden="true" />
      </button>
    </div>
    <div v-if="changing" class="move" :inert="busy">
      <ContentDirectorySelect v-model="target" data-testid="props-move-target" />
      <button type="button" class="primary small" :disabled="busy" data-testid="props-move-save" @click="move">{{ t.actions.confirm }}</button>
    </div>
  </div>
</template>

<style scoped>
.position { min-width: 0; }
.position-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  min-width: 0;
  min-height: var(--control-height);
  padding: 0 var(--space-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--canvas);
}
.location-link, .move-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-1);
}
.location-link { min-width: 0; text-align: left; }
.location-link svg { flex: none; color: var(--text-muted); }
.location-link span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.location-link:hover:not(:disabled), .move-link { color: var(--accent); }
.move-link { flex: none; }
.move { display: flex; align-items: stretch; gap: var(--space-2); margin-top: var(--space-2); }
.move > .app-select { flex: 1; min-width: 0; }
</style>
