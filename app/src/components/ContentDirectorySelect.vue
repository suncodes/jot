<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { DirectoryItem } from '@shared/files'
import { call } from '@/api'
import AppSelect from './AppSelect.vue'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
const model = defineModel<string>({ default: 'root' })
const { excludePath = '', allowPending = false, allowRoot = true } = defineProps<{ excludePath?: string; allowPending?: boolean; allowRoot?: boolean }>()
const directories = ref<DirectoryItem[]>([])
onMounted(async () => {
  try { directories.value = await call('content:directories', { recursive: true }) }
  catch (e) { useToastsStore().error((e as Error).message) }
})
</script>
<template>
  <AppSelect v-model="model" :label="t.directory.position" searchable :options="[...(allowPending ? [{ value: 'pending', label: t.directory.pendingPosition }] : []), ...(allowRoot ? [{ value: 'root', label: t.directory.root }] : []), ...directories.filter(d => !excludePath || d.path !== excludePath && !d.path.startsWith(excludePath + '/')).map(d => ({ value: d.path, label: d.path.slice(8) }))]" />
</template>
