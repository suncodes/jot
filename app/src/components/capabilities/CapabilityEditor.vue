<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, useId } from 'vue'
import { AlertCircle } from 'lucide-vue-next'
import { isSkillName, MAX_SKILL_TEXT_BYTES, type AgentConfiguration, type SkillChange } from '@shared/capabilities'
import AppDialog from '@/components/AppDialog.vue'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { dependencyProblems, type PreviewAgent, type PreviewSkill } from '@/capabilities/model'
import { t } from '@/strings'
const { kind, item = null, mode } = defineProps<{ kind: 'agents' | 'skills'; item?: PreviewAgent | PreviewSkill | null; mode: 'create' | 'edit' | 'copy' }>()
const emit = defineEmits<{ close: []; saveAgent: [agent: AgentConfiguration]; saveSkill: [change: Extract<SkillChange, { action: 'save' }>] }>()
const cap = useCapabilitiesStore()
const c = t.capabilities
const formId = useId()
const form = ref<HTMLFormElement | null>(null)
const agent = kind === 'agents' ? item as PreviewAgent | null : null
const skill = kind === 'skills' ? item as PreviewSkill | null : null
const automatic = mode === 'edit' && agent?.id === 'default'
function copyName(name: string): string {
  const names = kind === 'agents' ? cap.agents.map(entry => entry.name) : cap.skills.map(entry => entry.title)
  const base = kind === 'agents' ? c.copied(name).slice(0, 56) : c.copied(name)
  let result = base, count = 2
  while (names.includes(result)) result = `${base} ${count++}`
  return result
}
function copyIdentifier(): string {
  const base = (skill?.name ?? 'skill').slice(0, 54).replace(/-+$/, '') + '-copy'
  let result = base, count = 2
  while (cap.skills.some(entry => !entry.pluginId && entry.name === result)) result = `${base}-${count++}`
  return result
}
const draft = reactive({
  identifier: mode === 'copy' && skill ? copyIdentifier() : mode === 'edit' ? skill?.name ?? '' : '',
  name: item ? mode === 'copy' ? copyName(agent?.name ?? skill!.title) : agent?.name ?? skill!.title : '',
  description: item?.description ?? '', instructions: agent?.instructions ?? skill?.body ?? c.blankInstructions,
  skillIds: [...(agent?.skillIds ?? [])], toolIds: [...(agent?.toolIds ?? cap.catalog?.tools.filter(tool => !tool.loader && tool.enabled).map(tool => tool.id) ?? [])],
  declared: skill?.requiredTools !== null && skill?.requiredTools !== undefined, dependencies: [...(skill?.requiredTools ?? [])], replaceReferences: false, enabled: item?.enabled ?? true,
})
const baseline = JSON.stringify(draft)
const discard = ref(false)
const fields = reactive({ name: '', description: '', instructions: '', identifier: '' })
const singular = kind === 'agents' ? c.title : c.tabs.skills
const title = computed(() => discard.value ? c.discardTitle : `${mode === 'edit' ? c.edit : mode === 'copy' ? c.copy : ''}${mode === 'create' ? kind === 'agents' ? c.newAgent : c.newSkill : singular}`)
const tools = computed(() => cap.catalog?.tools.filter(tool => !tool.loader) ?? [])
const missingSkills = computed(() => draft.skillIds.filter(id => !cap.skills.some(entry => entry.id === id)))
const unknownTools = computed(() => draft.dependencies.filter(id => !tools.value.some(entry => entry.id === id)))
const problems = computed(() => {
  if (kind !== 'agents' || !draft.enabled) return []
  const disabled = draft.toolIds.filter(id => !tools.value.some(tool => tool.id === id && tool.enabled))
  return [...(disabled.length ? [c.missingTools(draft.name, disabled.join('、'))] : []), ...dependencyProblems(draft, cap.skills).map(problem =>
    problem.kind === 'skill' ? c.unavailableSkill(problem.skill!) : c.missingTools(problem.skill!, problem.tools?.join('、') ?? ''))]
})
const impact = computed(() => {
  if (!skill) return []
  const disabled = skill.enabled && !draft.enabled
  const needs = (tools: string[]) => draft.declared && draft.dependencies.some(id => !tools.includes(id))
  const tools = cap.catalog?.tools.filter(tool => !tool.loader && tool.enabled).map(tool => tool.id) ?? []
  return [...cap.agents.filter(entry => entry.id !== 'default' && entry.skillIds.includes(skill.id) && (disabled || needs(entry.toolIds))).map(entry => entry.name),
    ...(cap.catalog?.taskBindings.filter(binding => binding.skillId === skill.id && (disabled || needs(tools))).map(binding => c.taskLabels[binding.task]) ?? [])]
})
const fillableTools = computed(() => tools.value.filter(tool => !draft.toolIds.includes(tool.id)
  && cap.skills.some(skill => draft.skillIds.includes(skill.id) && skill.requiredTools?.includes(tool.id))).map(tool => tool.id))
const pendingSkill = shallowRef<Extract<SkillChange, { action: 'save' }> | null>(null)
function close(): void {
  if (cap.saving) return
  if (discard.value) { discard.value = false; return }
  if (JSON.stringify(draft) !== baseline) { discard.value = true; return }
  emit('close')
}
async function save(): Promise<void> {
  if (cap.saving) return
  cap.error = ''
  const name = draft.name.trim(), description = draft.description.trim(), instructions = kind === 'skills' ? draft.instructions : draft.instructions.trim()
  fields.name = name ? '' : c.fieldRequired(c.name)
  fields.description = description ? '' : c.fieldRequired(c.description)
  fields.instructions = instructions.trim() ? '' : c.fieldRequired(c.instructionsTitle[kind])
  fields.identifier = ''
  if (kind === 'agents' && name && cap.agents.some(entry => (mode !== 'edit' || entry.id !== item?.id) && entry.name.toLowerCase() === name.toLowerCase())) fields.name = c.duplicateName
  const identifier = draft.identifier.trim()
  if (kind === 'skills' && (!isSkillName(identifier) || cap.skills.some(s => !s.pluginId && s.name === identifier && (mode !== 'edit' || s.id !== item?.id)))) fields.identifier = c.identifierInvalid
  if (Object.values(fields).some(Boolean)) { await nextTick(); form.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); return }
  if (problems.value.length) { form.value?.querySelector('[data-testid="cap-dependency-error"]')?.scrollIntoView({ block: 'nearest' }); return }
  if (kind === 'agents') {
    const id = mode === 'edit' ? item!.id : `custom-${crypto.randomUUID()}`
    emit('saveAgent', { id, name, description, instructions, skillIds: [...draft.skillIds], toolIds: [...draft.toolIds], enabled: draft.enabled })
    return
  }
  const change = {
    action: 'save' as const,
    content: { name: identifier, title: name, description, body: instructions, requiredTools: draft.declared ? [...draft.dependencies] : null },
    enabled: draft.enabled,
    ...(mode === 'edit' ? { id: skill!.id } : mode === 'copy' ? { copyFrom: skill!.id, replaceReferences: draft.replaceReferences } : {}),
  }
  if (mode === 'edit' && impact.value.length) pendingSkill.value = change
  else emit('saveSkill', change)
}
</script>
<template>
  <AppDialog :title :busy="cap.saving" :class="discard ? 'cap-confirm-dialog' : 'cap-editor-dialog'" scroll-body @close="close">
    <template #heading><div class="cap-dialog-heading"><p v-if="!discard">{{ kind === 'agents' ? c.agentConfig : c.skillConfig }}</p><h2>{{ title }}</h2></div></template>
    <div v-if="discard" data-testid="cap-discard"><p>{{ c.discardText }}</p></div>
    <form v-else :id="formId" ref="form" class="cap-form" novalidate data-testid="cap-editor" @submit.prevent="save">
      <div class="cap-field"><label :for="formId + '-name'">{{ c.name }}</label><input :id="formId + '-name'" v-model="draft.name" type="text" :maxlength="kind === 'skills' ? MAX_SKILL_TEXT_BYTES : 60" :aria-invalid="!!fields.name" :aria-describedby="fields.name ? formId + '-name-error' : undefined" :placeholder="c.namePlaceholder" :readonly="automatic" data-testid="cap-edit-name" autofocus @input="fields.name = ''" /><p v-if="fields.name" :id="formId + '-name-error'" class="cap-field-error" role="alert">{{ fields.name }}</p></div>
      <div class="cap-field"><label :for="formId + '-description'">{{ c.description }}</label><textarea :id="formId + '-description'" v-model="draft.description" rows="2" :maxlength="kind === 'skills' ? MAX_SKILL_TEXT_BYTES : 2000" :aria-invalid="!!fields.description" :aria-describedby="fields.description ? formId + '-description-error' : undefined" :placeholder="c.descriptionPlaceholder" :readonly="automatic" data-testid="cap-edit-description" @input="fields.description = ''" /><p v-if="fields.description" :id="formId + '-description-error'" class="cap-field-error" role="alert">{{ fields.description }}</p></div>
      <div v-if="kind === 'skills'" class="cap-field"><label :for="formId + '-identifier'">{{ c.skillIdentifier }}</label><input :id="formId + '-identifier'" v-model="draft.identifier" type="text" maxlength="64" :readonly="mode === 'edit'" :aria-invalid="!!fields.identifier" :aria-describedby="formId + '-identifier-hint' + (fields.identifier ? ' ' + formId + '-identifier-error' : '')" :placeholder="c.identifierPlaceholder" data-testid="cap-edit-identifier" @input="fields.identifier = ''" /><p :id="formId + '-identifier-hint'" class="cap-field-hint">{{ c.identifierHint }}</p><p v-if="fields.identifier" :id="formId + '-identifier-error'" class="cap-field-error" role="alert">{{ fields.identifier }}</p></div>
      <div class="cap-field"><label :for="formId + '-instructions'">{{ c.instructionsTitle[kind] }}</label><textarea :id="formId + '-instructions'" v-model="draft.instructions" rows="5" :maxlength="MAX_SKILL_TEXT_BYTES" :aria-invalid="!!fields.instructions" :aria-describedby="fields.instructions ? formId + '-instructions-error' : undefined" :placeholder="c.instructionPlaceholder" data-testid="cap-edit-instructions" @input="fields.instructions = ''" /><p v-if="fields.instructions" :id="formId + '-instructions-error'" class="cap-field-error" role="alert">{{ fields.instructions }}</p></div>
      <p v-if="automatic" class="cap-field-hint" data-testid="cap-automatic-bindings">{{ c.automaticBindings }}</p>
      <template v-else-if="kind === 'agents'">
        <fieldset><legend>{{ c.skills }}<span>{{ c.optional }}</span></legend><div class="cap-choice-grid"><label v-for="entry in cap.skills" :key="entry.id" class="cap-choice" :class="{ checked: draft.skillIds.includes(entry.id) }"><input v-model="draft.skillIds" type="checkbox" :value="entry.id" :disabled="draft.enabled && !entry.enabled && !draft.skillIds.includes(entry.id)" :data-testid="'cap-bind-' + entry.id" /><span>{{ entry.title }}<small>{{ entry.enabled ? '/' + entry.id : c.unavailableBinding }}</small></span></label><label v-for="id in missingSkills" :key="id" class="cap-choice checked"><input v-model="draft.skillIds" type="checkbox" :value="id" data-testid="cap-unbind-missing" /><span>{{ c.missingBinding }}<small>{{ id }}</small></span></label></div><p v-if="!cap.skills.length" class="cap-field-hint">{{ c.noSkillAvailable }}</p></fieldset>
        <fieldset><legend>{{ c.tools }}</legend><div class="cap-choice-grid"><label v-for="entry in tools" :key="entry.id" class="cap-choice" :class="{ checked: draft.toolIds.includes(entry.id) }"><input v-model="draft.toolIds" type="checkbox" :value="entry.id" :data-testid="'cap-allow-' + entry.id" /><span>{{ entry.title }}<small>{{ !entry.enabled ? c.disabled : entry.access === 'write' ? c.writable : c.readonly }}</small></span></label></div><p class="cap-field-hint">{{ c.loaderHint }}</p></fieldset>
      </template>
      <template v-else><label class="cap-check-inline"><input v-model="draft.declared" type="checkbox" data-testid="cap-declare-tools" />{{ c.dependencies }}<small v-if="!draft.declared">{{ c.noDependency }}</small></label><fieldset v-if="draft.declared"><legend>{{ c.dependencies }}</legend><div class="cap-choice-grid"><label v-for="entry in tools" :key="entry.id" class="cap-choice" :class="{ checked: draft.dependencies.includes(entry.id) }"><input v-model="draft.dependencies" type="checkbox" :value="entry.id" :data-testid="'cap-require-' + entry.id" /><span>{{ entry.title }}<small>{{ !entry.enabled ? c.disabled : entry.access === 'write' ? c.writable : c.readonly }}</small></span></label><label v-for="id in unknownTools" :key="id" class="cap-choice checked"><input v-model="draft.dependencies" type="checkbox" :value="id" /><span>{{ c.unknownTool }}<small>{{ id }}</small></span></label></div><p class="cap-field-hint">{{ c.dependencyEditorHint }}</p></fieldset></template>
      <div v-if="problems.length" class="cap-notice" role="alert" data-testid="cap-dependency-error"><AlertCircle :size="15" /><div><p v-for="problem in problems" :key="problem">{{ problem }}</p><button v-if="fillableTools.length" type="button" data-testid="cap-fill-tools" @click="draft.toolIds.push(...fillableTools)">{{ c.fillTools }}</button></div></div>
      <label v-if="kind === 'skills' && mode === 'copy'" class="cap-check-inline"><input v-model="draft.replaceReferences" type="checkbox" data-testid="cap-copy-references" />{{ c.replaceReferences }}</label>
      <label v-if="!automatic" class="cap-check-inline"><input v-model="draft.enabled" type="checkbox" data-testid="cap-edit-enabled" />{{ kind === 'agents' ? c.enableAgent : c.enableSkill }}</label>
    </form>
    <template #footer><div v-if="discard" class="dialog-actions"><button @click="discard = false">{{ c.keepEditing }}</button><button class="primary" data-testid="cap-discard-confirm" @click="emit('close')">{{ c.discard }}</button></div><template v-else><p v-if="cap.error" class="cap-field-error" role="alert" data-testid="cap-editor-error">{{ cap.error }}</p><div class="cap-editor-footer"><span>{{ c.editorNotice }}</span><div class="dialog-actions"><button type="button" :disabled="cap.saving" @click="close">{{ c.cancel }}</button><button type="submit" :form="formId" class="primary" :disabled="cap.saving" data-testid="cap-edit-save">{{ mode === 'edit' ? c.save : c.create }}</button></div></div></template></template>
  </AppDialog>
  <AppDialog v-if="pendingSkill" :title="c.saveImpactTitle" @close="pendingSkill = null"><p>{{ c.saveImpactHint }}</p><p class="small">{{ impact.join('、') }}</p><template #footer><div class="dialog-actions"><button @click="pendingSkill = null">{{ c.keepEditing }}</button><button class="primary" data-testid="cap-impact-confirm" @click="emit('saveSkill', pendingSkill!); pendingSkill = null">{{ c.saveAnyway }}</button></div></template></AppDialog>
</template>
