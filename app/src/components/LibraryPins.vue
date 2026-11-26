<script setup lang="ts">
import { computed } from 'vue'
import { FileText, Folder, TriangleAlert } from 'lucide-vue-next'
import type { LibraryPin } from '@shared/files'
import type { MenuAction } from '@/utils/objectActions'
import { useLibraryPinsStore } from '@/stores/pins'
import { useLibraryStore } from '@/stores/library'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import ObjectMenu from './ObjectMenu.vue'
import { t } from '@/strings'

const pins = useLibraryPinsStore()
const library = useLibraryStore()
const tabs = useTabsStore()
const name = (pin: LibraryPin) => pin.kind === 'folder' ? pin.path.split('/').pop()! : pin.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '')
const entries = computed(() => pins.items.map((pin, index) => ({
  ...pin, name: name(pin),
  parent: pins.items.some(other => other !== pin && name(other).toLocaleLowerCase() === name(pin).toLocaleLowerCase())
    ? pin.path.split('/').slice(0, -1).join('/').replace(/^content\//, '') : '',
  actions: [
    { id: 'up', label: t.pins.up, disabled: index === 0, testId: 'pin-up' },
    { id: 'down', label: t.pins.down, disabled: index === pins.items.length - 1, testId: 'pin-down' },
    { id: 'remove', label: t.pins.remove, separated: true, testId: 'pin-remove' },
  ] satisfies MenuAction[],
})))
async function choose(pin: LibraryPin, action: string): Promise<void> {
  try {
    if (action === 'remove') await pins.set(pin.path, pin.kind, false)
    else await pins.reorder(pin.path, action as 'up' | 'down')
  } catch (e) { useToastsStore().error((e as Error).message) }
}
function open(pin: LibraryPin): void {
  if (pin.missing) return
  if (pin.kind === 'folder') library.select({ directoryPath: pin.path })
  else void tabs.open(pin.path, { newTab: true }).catch(e => useToastsStore().error((e as Error).message))
}
</script>

<template>
  <section v-if="entries.length" class="library-group pins-section" :aria-label="t.pins.title" data-testid="library-pins">
    <div class="library-group-heading"><h2>{{ t.pins.title }}</h2></div>
    <ul>
      <li v-for="pin in entries" :key="pin.path" class="pin-row" :class="{ missing: pin.missing, selected: !pin.missing && (pin.kind === 'folder' ? library.scope.directoryPath === pin.path : tabs.activePath === pin.path) }" data-object-row :data-pin-path="pin.path">
        <button class="ghost pin-link" :disabled="pin.missing" :title="pin.path + (pin.missing ? '\n' + t.pins.missingHint : '')" data-testid="pin-open" @click="open(pin)">
          <TriangleAlert v-if="pin.missing" :size="14" /><Folder v-else-if="pin.kind === 'folder'" :size="15" /><FileText v-else :size="15" />
          <span class="pin-text"><span class="pin-name">{{ pin.name }}</span><span v-if="pin.parent" class="pin-parent">{{ pin.parent }}</span></span>
          <span v-if="pin.missing" class="pin-status">{{ t.pins.missing }}</span>
        </button>
        <ObjectMenu :actions="pin.actions" :label="t.actions.more" trigger-id="pin-more" menu-id="pin-menu" @select="choose(pin, $event)" />
      </li>
    </ul>
  </section>
</template>

<style scoped>
ul { padding:0; margin:0; list-style:none; }
.pin-row { display:flex; align-items:center; min-width:0; margin-bottom:var(--space-1); border-radius:var(--radius-s); color:var(--text-muted); }
.pin-link { display:flex; align-items:center; gap:var(--space-2); flex:1; min-width:0; padding:var(--space-2) var(--space-3) var(--space-2) var(--space-6); text-align:left; color:inherit; }
.pin-link svg { flex:none; }
.pin-text { display:flex; flex-direction:column; min-width:0; }
.pin-name, .pin-parent { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.pin-parent, .pin-status { color:var(--text-faint); font-size:var(--font-size-small); }
.pin-status { flex:none; margin-left:auto; }
.pin-row :deep(.object-more) { width:24px; height:28px; padding:0; }
.selected { color:var(--accent); background:var(--accent-soft); }
.missing .pin-link { opacity:0.7; }
</style>
