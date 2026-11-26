<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import AppSelect from '@/components/AppSelect.vue'
import { call } from '@/api'
import { t } from '@/strings'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { AI_TASK_KINDS, type TaskSkillBindings } from '@shared/ai-tasks'
import { missingSkillTools, taskToolProblems, type CapabilityOwner, type CapabilityResource, type PluginDefinition } from '@shared/capabilities'

const { mode, id = '', owner = 'plugin' } = defineProps<{ mode: 'plugin' | 'copy' | 'resources' | 'tasks'; id?: string; owner?: CapabilityOwner }>()
const emit = defineEmits<{ close: []; saved: [id: string] }>()
const cap = useCapabilitiesStore(), c = t.capabilities
const error = ref(''), loading = ref(true), manifest = ref(''), resources = ref<CapabilityResource[]>([])
const resource = ref(''), content = ref(''), enabled = ref(true), target = ref(''), name = ref(''), replace = ref(false)
const tasks = reactive({} as TaskSkillBindings)
const confirmation = ref<'discard' | 'delete' | null>(null), nextResource = ref<string | null>(null)
const baseline = ref(''), resourceBaseline = ref('')
const formValue = () => JSON.stringify({ manifest: manifest.value, enabled: enabled.value, target: target.value, name: name.value, replace: replace.value, tasks })
const resourceValue = () => JSON.stringify([resource.value, content.value])
const bundled = computed(() => owner === 'plugin' ? cap.catalog?.plugins.find(plugin => plugin.id === id)?.source === 'bundled'
  : !!cap.skills.find(skill => skill.id === id)?.pluginId && cap.catalog?.plugins.find(plugin => plugin.id === cap.skills.find(skill => skill.id === id)?.pluginId)?.source === 'bundled')
const dirty = computed(() => mode === 'resources' ? !bundled.value && resourceValue() !== resourceBaseline.value : formValue() !== baseline.value)
const title = computed(() => confirmation.value === 'discard' ? c.discardTitle : confirmation.value === 'delete' ? c.deleteResource
  : mode === 'tasks' ? c.taskBindings : mode === 'resources' ? c.resources : mode === 'copy' ? c.pluginCopy : id ? c.editPlugin : c.newPlugin)
const options = computed(() => cap.skills.filter(skill => skill.enabled).map(skill => ({ value: skill.id, label: skill.title + ' · ' + skill.id })))

function taskProblems(task: typeof AI_TASK_KINDS[number]): string[] {
  const skill = cap.skills.find(skill => skill.id === tasks[task])
  if (!skill?.enabled) return [c.unavailableSkill(tasks[task])]
  if (taskToolProblems(skill).length) return taskToolProblems(skill)
  const tools = cap.catalog?.tools.filter(tool => !tool.loader && tool.enabled).map(tool => tool.id) ?? []
  const missing = missingSkillTools(skill, tools)
  return missing.length ? [c.missingTools(skill.title, missing.join('、'))] : []
}
onMounted(async () => {
  cap.error = ''
  try {
    if (mode === 'plugin' && id) {
      manifest.value = await call('capabilities:readResource', { owner: 'plugin', id, path: 'plugin.json' })
      enabled.value = cap.catalog!.plugins.find(plugin => plugin.id === id)!.enabled
    } else if (mode === 'plugin') manifest.value = JSON.stringify({ schemaVersion: 1, id: 'my-plugin', name: '我的插件', description: '自定义做事方法',
      agents: [{ id: 'assistant', name: '自建助手', description: '按说明工作', skillIds: [], toolIds: ['read', 'search'] }], skills: [], requiredTools: [] }, null, 2)
    else if (mode === 'copy') { target.value = id + '-copy'; name.value = cap.catalog?.plugins.find(plugin => plugin.id === id)?.name + ' 副本' }
    else if (mode === 'resources') resources.value = await call('capabilities:resources', { owner, id })
    else for (const binding of cap.catalog!.taskBindings) tasks[binding.task] = binding.skillId
  } catch (e) { error.value = (e as Error).message }
  finally { baseline.value = formValue(); resourceBaseline.value = resourceValue(); loading.value = false }
})
function close(): void {
  if (cap.saving || loading.value) return
  if (confirmation.value) { confirmation.value = null; return }
  if (dirty.value) { nextResource.value = null; confirmation.value = 'discard'; return }
  emit('close')
}
async function choose(path: string): Promise<void> {
  if (cap.saving || loading.value) return
  if (dirty.value && confirmation.value !== 'discard') { nextResource.value = path; confirmation.value = 'discard'; return }
  confirmation.value = null; error.value = ''; cap.error = ''; loading.value = true
  try {
    const text = path ? await call('capabilities:readResource', { owner, id, path }) : ''
    resource.value = path; content.value = text; resourceBaseline.value = resourceValue()
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}
function discard(): void {
  if (nextResource.value !== null) void choose(nextResource.value)
  else emit('close')
}
async function save(remove = false): Promise<void> {
  if (cap.saving || loading.value) return
  error.value = ''
  try {
    let ok = false, selected = id
    if (mode === 'tasks') ok = await cap.setTaskSkills(Object.fromEntries(AI_TASK_KINDS.filter(task => tasks[task] !== cap.catalog!.taskBindings.find(binding => binding.task === task)!.skillId).map(task => [task, tasks[task]])))
    else if (mode === 'copy') { selected = target.value.trim(); ok = await cap.changePlugin({ action: 'copy', id, targetId: selected, name: name.value.trim(), replaceReferences: replace.value }) }
    else if (mode === 'resources') ok = await cap.patchResources(owner, id, [{ path: resource.value.trim(), content: remove ? null : content.value }])
    else {
      const value = JSON.parse(manifest.value) as PluginDefinition
      selected = value.id
      const files = id ? [] : [
        ...(value.agents ?? []).map(agent => ({ path: 'agents/' + agent.id + '/PROMPT.md', content: c.blankInstructions })),
        ...(value.skills ?? []).map(skill => ({ path: 'skills/' + skill + '/SKILL.md',
          content: ['---', 'name: ' + skill, 'description: ' + JSON.stringify(value.description), 'required_tools: []', '---', '# ' + skill, '', c.blankInstructions, ''].join('\n') })),
      ]
      ok = await cap.changePlugin({ action: 'save', ...(id ? { id } : {}), manifest: value, files, enabled: enabled.value })
    }
    if (ok) { emit('saved', selected); emit('close') }
    else confirmation.value = null
  } catch (e) { error.value = (e as Error).message; confirmation.value = null }
}
</script>
<template>
  <AppDialog :title :busy="cap.saving || loading" scroll-body :class="confirmation ? 'cap-confirm-dialog' : 'cap-editor-dialog'" @close="close">
    <div v-if="confirmation === 'discard'" data-testid="cap-manager-discard"><p>{{ c.discardText }}</p></div>
    <div v-else-if="confirmation === 'delete'" data-testid="cap-resource-confirmation"><p>{{ c.resourceDeleteHint }}</p><code>{{ resource }}</code></div>
    <p v-else-if="loading">{{ c.loading }}</p>
    <form v-else id="cap-manager-form" class="cap-form" data-testid="cap-manager" @submit.prevent="save()">
      <template v-if="mode === 'tasks'">
        <p class="cap-field-hint">{{ c.taskBindingHint }}</p>
        <label v-for="task in AI_TASK_KINDS" :key="task" class="cap-field">{{ c.taskLabels[task] }}
          <AppSelect v-model="tasks[task]" :options="[{ value: tasks[task], label: options.find(option => option.value === tasks[task])?.label ?? tasks[task] }, ...options.filter(option => option.value !== tasks[task])]" :label="c.taskLabels[task]" :data-testid="'cap-task-' + task" />
          <small v-if="taskProblems(task).length" class="cap-field-error">{{ taskProblems(task).join('；') }}</small>
        </label>
      </template>
      <template v-else-if="mode === 'copy'">
        <label class="cap-field">{{ c.copyTarget }}<input v-model="target" type="text" data-testid="cap-plugin-copy-id" /></label>
        <label class="cap-field">{{ c.name }}<input v-model="name" type="text" data-testid="cap-plugin-copy-name" /></label>
        <label class="cap-check-inline"><input v-model="replace" type="checkbox" data-testid="cap-plugin-copy-references" />{{ c.replaceReferences }}</label>
      </template>
      <template v-else-if="mode === 'plugin'">
        <label class="cap-field">{{ c.pluginManifest }}<textarea v-model="manifest" rows="16" spellcheck="false" class="selectable" data-testid="cap-plugin-manifest" /></label>
        <p class="cap-field-hint">{{ c.pluginFilesHint }}</p>
        <label class="cap-check-inline"><input v-model="enabled" type="checkbox" />{{ c.enable }}</label>
      </template>
      <template v-else>
        <p class="cap-field-hint">{{ c.resourceHint }}</p>
        <div class="cap-resource-list" :aria-label="c.resourceChoose"><button v-for="file in resources" :key="file.path" type="button" class="ghost" :aria-pressed="resource === file.path" :disabled="!file.text" @click="choose(file.path)"><code>{{ file.path }}</code><small>{{ c.resourceBytes(file.bytes) }}</small></button><p v-if="!resources.length" class="cap-field-hint">{{ c.resourceEmpty }}</p></div>
        <button v-if="!bundled" type="button" class="ghost" @click="choose('')">{{ c.resourceNew }}</button>
        <label class="cap-field">{{ c.resourcePath }}<input v-model="resource" type="text" :readonly="bundled" data-testid="cap-resource-path" /></label>
        <label class="cap-field">{{ c.resourceContent }}<textarea v-model="content" rows="14" :readonly="bundled" spellcheck="false" data-testid="cap-resource-content" /></label>
        <p v-if="!bundled" class="cap-field-hint">{{ c.resourceOverwrite }}</p>
      </template>
      <p v-if="error || cap.error" class="cap-field-error" role="alert">{{ error || cap.error }}</p>
    </form>
    <template #footer><div v-if="confirmation === 'discard'" class="dialog-actions"><button @click="confirmation = null">{{ c.keepEditing }}</button><button class="primary" data-testid="cap-manager-discard-confirm" @click="discard">{{ c.discard }}</button></div>
      <div v-else-if="confirmation === 'delete'" class="dialog-actions"><button :disabled="cap.saving" @click="confirmation = null">{{ c.cancel }}</button><button class="primary" :disabled="cap.saving" data-testid="cap-resource-delete-confirm" @click="save(true)">{{ c.confirm }}</button></div>
      <div v-else class="dialog-actions">
        <button :disabled="cap.saving || loading" @click="close">{{ c.cancel }}</button>
        <button v-if="mode === 'resources' && !bundled && resources.some(file => file.path === resource)" :disabled="cap.saving" data-testid="cap-resource-delete" @click="confirmation = 'delete'">{{ c.deleteResource }}</button>
        <button v-if="mode !== 'resources' || !bundled" type="submit" form="cap-manager-form" class="primary" :disabled="loading || cap.saving || mode === 'tasks' && !dirty || mode === 'resources' && !resource.trim()" data-testid="cap-manager-save">{{ c.save }}</button>
      </div>
    </template>
  </AppDialog>
</template>
