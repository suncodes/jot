<script setup lang="ts">
import { useCapabilitiesStore } from '@/stores/capabilities'
import { toolIcon } from '@/capabilities/presentation'
import { t } from '@/strings'
defineProps<{ ids: string[] }>()
const emit = defineEmits<{ open: [id: string] }>()
const cap = useCapabilitiesStore()
</script>
<template>
  <div class="cap-tool-tags"><button v-for="id in ids" :key="id" :disabled="!cap.catalog?.tools.some(tool => tool.id === id)" @click="emit('open', id)"><component :is="toolIcon(id)" :size="12" />{{ cap.catalog?.tools.find(tool => tool.id === id)?.title ?? id }}</button><span v-if="!ids.length" class="small muted">{{ t.capabilities.noTools }}</span></div>
</template>
