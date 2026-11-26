<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Copy, FilePenLine } from 'lucide-vue-next'
import type { NoteTemplate } from '@shared/app-extensions'
import type { TreeNode } from '@shared/types'
import { call } from '@/api'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
import AppDialog from '@/components/AppDialog.vue'
import AppSelect from '@/components/AppSelect.vue'

const model = defineModel<NoteTemplate>({ required: true })
const { extensionId, defaultTemplate, active, label = t.extensions.template, prefix = 'profile' } = defineProps<{
  extensionId: string; defaultTemplate: NoteTemplate; active: boolean; label?: string; prefix?: string
}>()
const emit = defineEmits<{ valid: [value: boolean] }>()
const labels = t.extensions, toasts = useToastsStore()
const templateText = ref(''), error = ref(''), loading = ref(true), open = ref(false)
const userTemplates = ref<string[]>([])
const copyOpen = ref(false), copyTarget = ref('templates/' + extensionId + (prefix === 'profile' ? '' : '-okr') + '.md'), copyError = ref(''), copying = ref(false)
const copyPrefix = prefix === 'profile' ? 'template' : prefix + '-template'
const templatePath = computed({
  get: () => model.value.kind === 'none' ? '' : model.value.path,
  set: path => { if (model.value.kind !== 'none') model.value = { kind: model.value.kind, path } },
})
const valid = computed(() => !error.value && !loading.value && !copying.value)
watch(valid, value => emit('valid', value), { immediate: true })
watch(() => active, visible => { if (!visible) copyOpen.value = false })
watch([() => JSON.stringify(model.value), () => active], ([, visible], _old, cleanup) => {
  if (!visible) return
  let current = true
  templateText.value = ''; error.value = ''; loading.value = true
  const template = JSON.parse(JSON.stringify(model.value)) as NoteTemplate
  const timer = setTimeout(() => {
    void call('extensions:readTemplate', { id: extensionId, template })
      .then(text => { if (current) templateText.value = text })
      .catch(failure => { if (current) error.value = (failure as Error).message })
      .finally(() => { if (current) loading.value = false })
  }, 180)
  cleanup(() => { current = false; clearTimeout(timer) })
}, { immediate: true })
function setKind(kind: NoteTemplate['kind']): void {
  model.value = kind === 'none' ? { kind }
    : { kind, path: kind === 'package' ? defaultTemplate.kind === 'package' ? defaultTemplate.path : 'templates/default.md' : userTemplates.value[0] ?? 'templates/' }
}
async function copy(): Promise<void> {
  if (copying.value || model.value.kind !== 'package') return
  copying.value = true; copyError.value = ''
  try {
    const result = await call('extensions:copyTemplate', { id: extensionId, path: model.value.path.trim(), targetPath: copyTarget.value.trim() })
    model.value = { kind: 'user', path: result.path }
    userTemplates.value = [...new Set([...userTemplates.value, result.path])]
    copyOpen.value = false; toasts.info(labels.copied)
  } catch (failure) { copyError.value = (failure as Error).message }
  finally { copying.value = false }
}
async function edit(): Promise<void> {
  try { await useTabsStore().open(templatePath.value.trim(), { newTab: true, startEditing: true }) }
  catch (failure) { toasts.error((failure as Error).message) }
}
onMounted(async () => {
  const flatten = (nodes: TreeNode[]): string[] => nodes.flatMap(node => node.kind === 'dir' ? flatten(node.children ?? []) : /\.(md|markdown)$/i.test(node.path) ? [node.path] : [])
  try { userTemplates.value = flatten(await call('vault:tree', { dir: 'templates' })) }
  catch (failure) { toasts.error((failure as Error).message) }
})
</script>
<template>
  <div class="template-field">
    <div class="profile-field"><span>{{ label }}</span><AppSelect :model-value="model.kind" :options="[{ value: 'none', label: labels.templateNone }, { value: 'package', label: labels.templatePackage }, { value: 'user', label: labels.templateUser }]" :label :data-testid="prefix + '-template-kind'" @update:model-value="setKind" /></div>
    <template v-if="model.kind !== 'none'">
      <div v-if="model.kind === 'user' && userTemplates.length" class="profile-field"><AppSelect v-model="templatePath" :options="userTemplates.map(path => ({ value: path, label: path }))" :label="labels.templateUser" searchable :data-testid="prefix + '-user-template'" /></div>
      <label class="profile-field profile-path">{{ labels.templatePath }}<input v-model.trim="templatePath" type="text" maxlength="1000" :data-testid="prefix + '-template-path'" /><small class="muted">{{ labels.templatePathHint }}</small></label>
      <div class="settings-actions"><button type="button" class="ghost" :data-testid="prefix + '-template-preview'" :aria-expanded="open" @click="open = !open">{{ labels.previewTemplate }}</button><button v-if="model.kind === 'package'" type="button" class="ghost" :data-testid="prefix + '-template-copy'" @click="copyError = ''; copyOpen = true"><Copy :size="14" />{{ labels.copyTemplate }}</button><button v-else type="button" class="ghost" :disabled="!valid" :data-testid="prefix + '-template-edit'" @click="edit"><FilePenLine :size="14" />{{ labels.editTemplate }}</button></div>
    </template>
    <p v-if="error" class="settings-error" role="alert" :data-testid="prefix + '-template-error'">{{ error }}</p>
    <pre v-if="open" class="template-preview selectable" :data-testid="prefix + '-template-content'">{{ loading ? labels.loading : templateText || labels.templateBlank }}</pre>
    <AppDialog v-if="copyOpen" :title="labels.copyTemplate" :busy="copying" @close="copyOpen = false"><form @submit.prevent="copy"><p class="small muted">{{ labels.copyHint }}</p><label>{{ labels.copyTarget }}<input v-model="copyTarget" type="text" :data-testid="copyPrefix + '-copy-target'" /></label><p v-if="copyError" class="settings-error" role="alert" :data-testid="copyPrefix + '-copy-error'">{{ copyError }}</p><div class="dialog-actions"><button type="button" :disabled="copying" @click="copyOpen = false">{{ t.common.cancel }}</button><button class="primary" :disabled="copying" :data-testid="copyPrefix + '-copy-confirm'">{{ labels.copy }}</button></div></form></AppDialog>
  </div>
</template>
<style scoped>
.template-field { min-width:0; padding:var(--space-4); background:var(--bg-secondary); border-radius:var(--radius-m); }
.template-field .settings-actions { row-gap:var(--space-2); }
.template-field .settings-actions > button:first-child { padding-left:0; color:var(--accent); }
.template-preview { max-height:240px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg-secondary); padding:var(--space-4); border-radius:var(--radius-m); font:var(--font-size-small)/1.7 var(--font-mono); }
</style>
