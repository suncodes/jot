<script setup lang="ts">
import { modelOptions, resolveModelSettings } from '@shared/models'
import { t } from '@/strings'
import { ArrowUp, ArrowUpRight, Bot, Check, ChevronDown, FileText, Folder, Plus, Search, Settings, Sparkles, Square, X } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { ContextBudget } from '@shared/model-budget'
import { reasoningModelKey, COMMON_REASONING_EFFORTS, type ReasoningEffort } from '@shared/reasoning'
import { useAppStore } from '@/stores/app'
import AppSelect from '@/components/AppSelect.vue'
import type { AssistantContext, MaterialReference } from '@shared/assistant'
import { call } from '@/api'
import AssistantReferences from './AssistantReferences.vue'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { useEditorContextStore } from '@/stores/editorContext'
import { CAPABILITIES_TAB, useTabsStore } from '@/stores/tabs'

const props = defineProps<{ context: AssistantContext; busy: boolean; loading: boolean; canAddCurrent: boolean; automaticReference: string | null; budget?: ContextBudget }>()
const text = defineModel<string>({ required: true })
const emit = defineEmits<{ send: []; stop: []; add: [reference: MaterialReference, replace: boolean]; remove: [index: number]; current: []; context: [value: AssistantContext] }>()
const c = t.agent
const cap = useCapabilitiesStore()
const app = useAppStore()
const selectedModel = computed(() => app.settings && resolveModelSettings(app.settings.models, props.context.modelId ?? app.settings.models.defaultModelId))
const reasoningModel = computed(() => selectedModel.value ? reasoningModelKey(selectedModel.value) : '')
const modelChoices = computed(() => {
  if (!app.settings) return []
  const actual = resolveModelSettings(app.settings.models)
  const options = [{ value: 'follow', label: '跟随全局 · ' + (actual ? actual.channelName + ' / ' + (actual.name || actual.model) : '未配置') }, ...modelOptions(app.settings.models)]
  if (props.context.modelId && !selectedModel.value) options.push({ value: props.context.modelId, label: '模型已删除，请重新选择' })
  return options
})
const modelChoice = computed({ get: () => props.context.modelId ?? 'follow', set: value => {
  const { modelId: _id, reasoningEffort: _effort, reasoningModel: _identity, ...context } = props.context
  emit('context', { ...context, ...(value === 'follow' ? {} : { modelId: value }) })
} })
const reasoningEfforts = ref<readonly ReasoningEffort[]>(COMMON_REASONING_EFFORTS)
const reasoningChoice = computed<ReasoningEffort | 'follow'>({
  get: () => props.context.reasoningEffort ?? 'follow',
  set: value => {
    const { reasoningEffort: _effort, reasoningModel: _model, ...context } = props.context
    emit('context', value === 'follow' ? context : {
      ...context, reasoningEffort: value,
      ...(reasoningModel.value ? { reasoningModel: reasoningModel.value } : {}),
    })
  },
})
const reasoningOptions = computed(() => [
  { value: 'follow' as const, label: t.reasoning.default },
  ...reasoningEfforts.value.filter(value => value !== 'auto').map(value => ({ value, label: t.reasoning.labels[value] })),
])
const editor = useEditorContextStore()
const tabs = useTabsStore()
const area = ref<HTMLElement | null>(null)
const box = ref<HTMLTextAreaElement | null>(null)
const agentTrigger = ref<HTMLButtonElement | null>(null)
const referenceTrigger = ref<HTMLButtonElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const mode = ref<'agents' | 'references' | 'skills' | null>(null)
const query = ref('')
const dismissedCurrent = ref('')
const popoverHeight = ref(420)
const token = ref<{ start: number; end: number; symbol: string; query: string; replace: boolean } | null>(null)
type Candidate = { id: string; title: string; detail: string; reference?: MaterialReference; skill?: string }
const options = ref<Candidate[]>([])
const active = ref(0)
const pickerError = ref('')
const waiting = ref(false)
const listId = useId()
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
const locked = computed(() => props.busy || props.loading)
const agent = computed(() => cap.agents.find(a => a.id === props.context.agentId))
const canChooseAgent = computed(() => cap.agents.filter(item => item.enabled).length > 1 || !agent.value?.enabled)
const agents = computed(() => cap.agents.filter(a => (a.name + a.description).toLowerCase().includes(query.value.trim().toLowerCase())))
const boundSkills = computed(() => cap.skills.filter(s => s.enabled && agent.value?.skillIds.includes(s.id)))
const problems = computed(() => cap.problems(props.context.agentId))
const canSend = computed(() => !props.loading && !!text.value.trim() && !problems.value.length && !(props.context.strict && !props.context.references.length) && !mode.value)
function strict(value: boolean): void { emit('context', { ...props.context, strict: value }) }
function measure(): void {
  const rect = area.value?.getBoundingClientRect()
  const top = area.value?.closest('[data-testid="agent-panel"]')?.getBoundingClientRect().top ?? 0
  if (rect) popoverHeight.value = Math.min(420, Math.max(80, rect.top - top - 8))
}
function fit(): void {
  const el = box.value
  if (el) { el.style.height = 'auto'; el.style.height = Math.min(150, Math.max(72, el.scrollHeight)) + 'px' }
  measure()
}
function close(restore = false): void {
  const target = token.value ? box.value : mode.value === 'agents' ? agentTrigger.value : referenceTrigger.value
  mode.value = null; token.value = null; sequence++; clearTimeout(timer); waiting.value = false
  if (restore) target?.focus()
}
function detect(): void {
  if (locked.value) return
  const end = box.value?.selectionStart ?? text.value.length
  const before = text.value.slice(0, end)
  const match = /(?:^|\s)([@/$])([^\s@$]*)$/.exec(before)
  if (!match) { if (token.value) close(); return }
  token.value = {
    start: end - match[2]!.length - 1, end, symbol: match[1]!, query: match[2]!,
    // 仅明确的引用命令前缀触发限定，普通时间词不参与判断。
    replace: /(?:只看|只根据|仅根据)\s*$/.test(before.slice(0, end - match[2]!.length - 1)),
  }
  mode.value = match[1] === '@' ? 'references' : 'skills'
  measure()
}
async function search(): Promise<void> {
  const mine = ++sequence
  options.value = []; active.value = 0; pickerError.value = ''; waiting.value = false
  if (!mode.value || mode.value === 'agents') return
  const q = (token.value?.query ?? query.value).trim().toLowerCase()
  if (mode.value === 'skills') {
    options.value = boundSkills.value.filter(s => (s.name + s.title + s.description).toLowerCase().includes(q)).map(s => ({ id: s.id, title: s.title, detail: s.description, skill: s.id }))
    return
  }
  waiting.value = true
  try {
    const [files, content, ideas, inbox] = await Promise.all([
      call('doc:quickOpen', { query: q, limit: 30 }), call('content:directories', { recursive: true }),
      call('content:directories', { parentPath: 'ideas', recursive: true }),
      call('content:directories', { parentPath: 'inbox', recursive: true }),
    ])
    const directories = [
      { path: 'ideas', name: t.directory.ideasPosition }, { path: 'inbox', name: t.directory.pendingPosition },
      ...content, ...ideas, ...inbox,
    ]
    if (mine !== sequence) return
    const references: MaterialReference[] = [
      ...files.map(f => ({ kind: 'file' as const, value: f.path, title: f.title })),
      ...directories.filter(d => (d.path + ' ' + d.name).toLocaleLowerCase().includes(q)).map(d => ({ kind: 'folder' as const, value: d.path, title: d.name })),
    ]
    options.value = references.slice(0, 50).map(reference => ({ id: reference.kind + reference.value, title: reference.title, detail: reference.value, reference }))
  } catch (e) { if (mine === sequence) pickerError.value = (e as Error).message }
  finally { if (mine === sequence) waiting.value = false }
}
function pick(candidate: Candidate | undefined): void {
  if (!candidate || locked.value) return
  const selected = token.value
  if (candidate.reference) {
    // 先记录主动引用，再固定替换后的限定材料。
    if (selected?.replace) { emit('add', candidate.reference, true); emit('context', { ...props.context, references: [candidate.reference], strict: true }) }
    else emit('add', candidate.reference, false)
  }
  const skill = candidate.skill ? boundSkills.value.find(s => s.id === candidate.skill) : null
  const insertion = skill && selected ? selected.symbol + skill.id + ' ' : ''
  const caret = selected ? selected.start + insertion.length : box.value?.selectionStart ?? text.value.length
  if (selected) text.value = text.value.slice(0, selected.start) + insertion + text.value.slice(selected.end)
  close()
  void nextTick(() => { box.value?.focus(); box.value?.setSelectionRange(caret, caret); fit() })
}
function chooseAgent(id: string): void {
  if (locked.value || !cap.agents.find(a => a.id === id)?.enabled) return
  emit('context', { ...props.context, agentId: id, skillIds: [] })
  close(true)
}
function open(kind: 'agents' | 'references'): void {
  const previous = mode.value
  close()
  if (locked.value || previous === kind) return
  mode.value = kind; query.value = ''; active.value = kind === 'agents' ? Math.max(0, agents.value.findIndex(item => item.id === props.context.agentId && item.enabled)) : 0; measure()
  void search()
  void nextTick(() => searchInput.value?.focus())
}
function move(delta: number): void {
  const length = mode.value === 'agents' ? agents.value.length : options.value.length
  for (let i = 1; i <= length; i++) {
    const index = (active.value + delta * i + length) % length
    if (mode.value !== 'agents' || agents.value[index]?.enabled) { active.value = index; break }
  }
  void nextTick(() => document.getElementById(listId + '-' + active.value)?.scrollIntoView({ block: 'nearest' }))
}
function popupKeyboard(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229 || !mode.value) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1) }
  else if ((e.key === 'Enter' && (e.target === searchInput.value || e.target === box.value)) || (e.key === 'Tab' && token.value)) {
    e.preventDefault()
    if (mode.value === 'agents') { const item = agents.value[active.value]; if (item) chooseAgent(item.id) }
    else pick(options.value[active.value])
  }
}
function keyboard(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  if (mode.value) { popupKeyboard(e); return }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (canSend.value) emit('send') }
}
function outside(e: Event): void { if (mode.value && e.target instanceof Node && !area.value?.contains(e.target)) close() }
function escape(e: KeyboardEvent): void { if (mode.value && e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(true) } }
function manage(): void { cap.open('agents', props.context.agentId); close(); void tabs.open(CAPABILITIES_TAB, { newTab: true, title: t.capabilities.title }) }
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void search() }, 100) }
watch(token, schedule)
watch(query, () => { active.value = mode.value === 'agents' ? Math.max(0, agents.value.findIndex(item => item.enabled)) : 0; schedule() })
watch([text, boundSkills], () => {
  void nextTick(fit)
  // 技能保持 /name 或 $name 文本，删除命令时同时解除本轮显式加载。
  const commands = new Set([...text.value.matchAll(/(?:^|\s)[/$]([^\s/$，。！？,;]+)/g)].map(m => m[1]))
  const skillIds = boundSkills.value.filter(s => commands.has(s.id) || commands.has(s.name) && boundSkills.value.filter(other => other.name === s.name).length === 1).map(s => s.id)
  if (skillIds.join('\0') !== props.context.skillIds.join('\0')) emit('context', { ...props.context, skillIds })
})
watch(reasoningModel, (_value, _previous, cleanup) => {
  let active = true
  reasoningEfforts.value = COMMON_REASONING_EFFORTS
  const model = selectedModel.value
  if (!model) return
  void call('settings:reasoning', { baseUrl: model.baseUrl, model: model.model, protocol: model.protocol })
    .then(value => { if (active) reasoningEfforts.value = value.supported })
    .catch(error => { if (active) console.error('[assistant] 读取推理档位失败：', error) })
  cleanup(() => { active = false })
}, { immediate: true })
watch(locked, value => { if (value) close() })
watch(() => props.context, () => { dismissedCurrent.value = '' })
onMounted(() => { fit(); document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside); window.addEventListener('keydown', escape, true); window.addEventListener('resize', measure) })
onBeforeUnmount(() => { close(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside); window.removeEventListener('keydown', escape, true); window.removeEventListener('resize', measure) })
defineExpose({ focus: () => box.value?.focus() })
</script>
<template>
  <div ref="area" class="composer-area">
    <div v-if="canAddCurrent && dismissedCurrent !== editor.current?.path" class="current-note-offer">
      <button class="ghost" data-testid="agent-add-current" :disabled="locked" :title="editor.current?.title" @click="emit('current')"><Plus :size="12" />{{ c.addCurrent }}<span>{{ editor.current?.title }}</span></button>
      <button class="ghost offer-dismiss" :aria-label="c.dismissCurrent" @click="dismissedCurrent = editor.current?.path ?? ''"><X :size="12" /></button>
    </div>
    <div class="composer" data-testid="agent-composer">
      <AssistantReferences :context :locked :automatic-reference @remove="emit('remove', $event)" @strict="strict" />
      <textarea ref="box" v-model="text" rows="2" data-testid="agent-input" :placeholder="c.inputPlaceholder" :aria-label="c.questionLabel" :aria-expanded="!!token" :aria-controls="token ? listId : undefined" :aria-activedescendant="token && options.length ? listId + '-' + active : undefined" maxlength="20000" autocomplete="off" spellcheck="false" @input="detect" @click="detect" @keyup.left="detect" @keyup.right="detect" @keydown="keyboard" />
      <div class="composer-model-row"><AppSelect v-model="modelChoice" :options="modelChoices" label="对话模型" searchable :disabled="locked" data-testid="agent-model" @click="close()" /></div>
      <div class="composer-toolbar">
        <span v-if="!canChooseAgent" class="composer-choice agent-choice" :title="agent?.name" data-testid="agent-select" :data-value="agent?.id"><Bot :size="13" /><span>{{ agent?.name }}</span></span>
        <button v-else ref="agentTrigger" class="ghost composer-choice agent-choice" :title="agent?.name" :aria-label="c.chooseAgent" :aria-expanded="mode === 'agents'" :aria-controls="mode === 'agents' ? listId + '-popover' : undefined" aria-haspopup="dialog" :disabled="locked" data-testid="agent-select" @click="open('agents')"><Bot :size="13" /><span>{{ agent?.name || c.chooseAgent }}</span><ChevronDown :size="10" /></button>
        <button ref="referenceTrigger" class="ghost composer-choice reference-choice" :title="c.mentionTitle" :aria-label="c.mention" :aria-expanded="mode === 'references'" :aria-controls="mode === 'references' ? listId + '-popover' : undefined" aria-haspopup="dialog" :disabled="locked" data-testid="agent-mention" @click="open('references')"><span class="at-symbol" aria-hidden="true">@</span><span>{{ c.addReference }}</span></button>
        <div class="composer-choice reasoning-choice"><span>{{ t.reasoning.shortTitle }}</span><AppSelect :key="reasoningModel ?? ''" v-model="reasoningChoice" :options="reasoningOptions" :label="t.reasoning.title" data-testid="agent-reasoning-effort" @click="close()" /></div>
        <button v-if="busy" class="send-button running" :title="c.stopGenerate" :aria-label="c.stopGenerate" data-testid="agent-stop" @click="emit('stop')"><Square :size="13" /></button>
        <button v-else class="send-button" :title="c.send" :aria-label="c.send" data-testid="agent-send" :disabled="!canSend" @click="emit('send')"><ArrowUp :size="16" /></button>
      </div>
    </div>
    <div class="composer-foot"><span>{{ c.enterHint }}</span><span v-if="budget" class="context-budget" tabindex="0" data-testid="agent-context-budget" :class="{ 'context-near-limit': budget.blocked || budget.inputTokens >= budget.inputBudget * 0.85 }" :title="c.contextDetail(budget.inputTokens, budget.contextWindow, budget.maxOutputTokens, budget.safetyTokens, budget.omittedHistoryTurns, c.contextSources[budget.source], budget.summarizedTurns ?? 0)">{{ c.contextPercent(budget.percent) }}</span></div>
    <div v-if="problems.length" class="composer-problems small" role="status">{{ problems.join('；') }}<button class="ghost" @click="manage">{{ c.manage }}</button></div>
    <section v-if="mode" :id="listId + '-popover'" class="composer-popover" :style="{ maxHeight: popoverHeight + 'px' }" role="dialog" :aria-label="mode === 'agents' ? c.chooseAgent : mode === 'references' ? c.referenceMaterials : c.chooseSkill" @keydown="popupKeyboard">
      <div class="popover-heading"><strong>{{ mode === 'agents' ? c.chooseAgent : mode === 'references' ? token?.replace ? c.replaceReferences : c.addReferences : c.chooseSkill }}</strong><span>{{ mode === 'agents' ? c.nextQuestions : mode === 'references' ? c.referenceTypes : c.boundSkills }}</span></div>
      <label v-if="!token" class="assistant-popover-search"><Search :size="14" /><input ref="searchInput" v-model="query" type="search" autocomplete="off" :placeholder="mode === 'agents' ? c.agentSearch : c.addReferences" :aria-label="mode === 'agents' ? c.agentSearch : c.mention" :aria-controls="listId" :aria-activedescendant="listId + '-' + active" /></label>
      <div v-if="mode === 'agents'" :id="listId" role="listbox" :aria-label="c.chooseAgent" data-testid="select-options">
        <button v-for="(item, index) in agents" :id="listId + '-' + index" :key="item.id" class="ghost option-row" :class="{ active: index === active }" role="option" :data-value="item.id" :aria-selected="item.id === context.agentId" :disabled="!item.enabled" @click="chooseAgent(item.id)"><span class="option-mark"><Bot :size="17" /></span><span class="option-copy"><strong>{{ item.name }}<span v-if="!item.enabled" class="option-badge">{{ c.disabledAgent }}</span></strong><small>{{ item.description || c.noDescription }}</small></span><Check v-if="item.id === context.agentId" :size="14" /></button>
        <p v-if="!agents.length" class="assistant-empty-options">{{ c.noMatchingAgent }}</p>
      </div>
      <div v-else :id="listId" role="listbox" :aria-label="mode === 'references' ? c.mention : c.chooseSkill" data-testid="agent-candidates">
        <p v-if="waiting || pickerError || !options.length" class="assistant-empty-options">{{ waiting ? c.searching : pickerError || c.noCandidates }}</p>
        <button v-for="(option, index) in options" :id="listId + '-' + index" :key="option.id" class="ghost option-row" :class="{ active: index === active }" role="option" :data-path="option.reference?.value" :data-kind="option.reference?.kind" :aria-selected="index === active" @mousedown.prevent @click="pick(option)">
          <span class="option-mark"><Sparkles v-if="option.skill" :size="17" /><Folder v-else-if="option.reference?.kind === 'folder'" :size="17" /><FileText v-else :size="17" /></span>
          <span class="option-copy"><strong>{{ option.title }}<code v-if="option.skill">{{ token?.symbol }}{{ cap.skills.find(s => s.id === option.skill)?.id }}</code><span v-else class="option-type">{{ option.reference?.kind === 'folder' ? c.folderReference : c.fileReference }}</span></strong><small>{{ option.detail }}</small></span><Check v-if="option.reference && context.references.some(r => r.kind === option.reference!.kind && r.value === option.reference!.value)" :size="14" />
        </button>
      </div>
      <button v-if="mode === 'agents'" class="ghost popover-footer" data-testid="agent-manage" @click="manage"><Settings :size="13" />{{ c.manageAgents }}<ArrowUpRight :size="13" /></button>
      <div v-else class="picker-foot"><span>{{ mode === 'references' ? c.referenceModeHint : c.boundSkills }}</span><span><kbd>↑</kbd><kbd>↓</kbd> <kbd>Enter</kbd> <kbd>Esc</kbd></span></div>
    </section>
  </div>
</template>

<style scoped>
.composer-model-row { min-width:0; border-top:1px solid var(--border); margin-top:var(--space-1); padding-top:var(--space-1); }
.composer-model-row :deep(.select-control) { width:100%; max-width:100%; font-size:11px; min-height:28px; }
.composer-model-row :deep(.select-control > span) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
</style>
