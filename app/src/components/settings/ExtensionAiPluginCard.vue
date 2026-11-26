<script setup lang="ts">
import { computed } from 'vue'
import type { AppExtensionAiPlugin } from '@shared/app-extensions'
import { t } from '@/strings'

const { info, busy = false, selectable = false, selected = false } = defineProps<{
  info: AppExtensionAiPlugin; busy?: boolean; selectable?: boolean; selected?: boolean
}>()
const emit = defineEmits<{ 'update:selected': [value: boolean]; install: []; manage: [id: string] }>()
const labels = t.extensionAi
const canInstall = computed(() => info.installation.kind === 'missing' && !info.issues.length)
const status = computed(() => info.installation.kind === 'installed'
  ? info.installation.enabled ? labels.enabled : labels.disabled
  : info.installation.kind === 'occupied' ? labels.occupied : info.issues.length ? labels.unavailable : labels.missing)
</script>
<template>
  <section class="settings-card ai-plugin-card" data-testid="extension-ai-plugin">
    <div class="ai-plugin-heading"><h3>{{ labels.title }}</h3><span class="settings-badge" data-testid="extension-ai-state">{{ status }}</span></div>
    <strong>{{ info.name }}</strong><p class="small muted">{{ info.description }}</p>
    <code v-if="info.id" class="small selectable">{{ info.id }}</code>
    <p class="small muted">{{ labels.independentHint }}</p>
    <label v-if="selectable && canInstall" class="ai-plugin-choice"><input type="checkbox" :checked="selected" :disabled="busy" data-testid="extension-ai-select" @change="emit('update:selected', ($event.target as HTMLInputElement).checked)" />{{ labels.together }}</label>
    <button v-else-if="!selectable && canInstall" :disabled="busy" data-testid="extension-ai-install" @click="emit('install')">{{ labels.install }}</button>
    <button v-else-if="info.id && info.installation.kind !== 'missing'" class="ghost" :disabled="busy" data-testid="extension-ai-manage" @click="emit('manage', info.id)">{{ labels.manage }}</button>
    <p v-if="info.installation.kind === 'occupied'" class="settings-error" role="alert">{{ info.installation.reason }}</p>
    <p v-for="issue in info.issues" :key="issue" class="settings-error" role="alert">{{ issue }}</p>
    <template v-if="info.installation.kind === 'installed'"><p v-for="issue in info.installation.issues" :key="issue" class="settings-error">{{ issue }}</p></template>
    <details v-if="selectable && info.files.length"><summary class="small muted">{{ labels.files }}（{{ info.files.length }}）</summary><ul class="small selectable"><li v-for="file in info.files" :key="file"><code>{{ file }}</code></li></ul></details>
  </section>
</template>
<style scoped>
.ai-plugin-card { margin:var(--space-4) 0; overflow-wrap:anywhere; }
.ai-plugin-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); margin-bottom:var(--space-3); }
.ai-plugin-heading h3 { margin:0; }
.ai-plugin-card .ai-plugin-choice { display:flex; align-items:center; gap:var(--space-2); }
.ai-plugin-card details { margin-top:var(--space-3); }
.ai-plugin-card summary { cursor:pointer; width:fit-content; }
.ai-plugin-card ul { max-height:160px; overflow:auto; padding-left:var(--space-4); }
</style>
