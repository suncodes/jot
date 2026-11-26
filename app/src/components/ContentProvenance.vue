<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { FileLink } from '@shared/files'
import { call, on } from '@/api'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
const { path } = defineProps<{ path: string }>()
const sources = ref<FileLink[]>([])
let tick = 0
const offs: (() => void)[] = []
async function load(): Promise<void> {
  const request = ++tick
  const result = await call('links:list', { path })
  if (request === tick) sources.value = result.filter(r => r.kind === 'source')
}
function refresh(): void { void load().catch(e => useToastsStore().error((e as Error).message)) }
watch(() => path, refresh)
onMounted(() => { refresh(); offs.push(on('storage:changed', refresh), on('vault:changed', refresh)) })
onUnmounted(() => { tick++; offs.forEach(off => off()) })
</script>
<template>
  <div v-if="sources.length" class="provenance" data-testid="content-provenance">
    <div v-for="source in sources" :key="source.target">
      <span>{{ t.agent.sources }}：</span><button class="ghost small" :disabled="source.missing" @click="useTabsStore().open(source.path ?? source.target, { newTab: true, reader: 'source' })">{{ source.target.replace(/^content\//, '') }}</button>
      <span v-if="source.missing" class="warning">{{ t.directory.missing }}</span>
    </div>
  </div>
</template>
<style scoped>
.provenance { padding:var(--space-2) 0; overflow-wrap:anywhere; }
button { padding:0 var(--space-1); color:var(--accent); white-space:normal; text-align:left; }
.warning { color:var(--warning); }
</style>
