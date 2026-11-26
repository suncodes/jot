<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ApiError, call } from '@/api'
import { useAppStore } from '@/stores/app'
import { t } from '@/strings'
import AppSelect from '@/components/AppSelect.vue'
import { COMMON_REASONING_EFFORTS, type ReasoningEffort, type ResolvedReasoning } from '@shared/reasoning'
import { COMPACTION_THRESHOLDS, CONTEXT_WINDOW_PRESETS, DEFAULT_COMPACTION_THRESHOLD, MODEL_BUDGET_BOUNDS, type CompactionThreshold, type ResolvedModelBudget } from '@shared/model-budget'

// 模型配置表单：首次启动引导和设置页共用。
const app = useAppStore()
const initialWindow = app.settings?.model.contextWindow
const form = reactive({
  baseUrl: app.settings?.model.baseUrl ?? '',
  model: app.settings?.model.model ?? '',
  apiKey: '',
  reasoningEffort: app.settings?.model.reasoningEffort ?? 'auto',
  contextWindow: (initialWindow ?? '') as number | '',
  threshold: String(app.settings?.model.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD),
})
const windowChoice = ref(initialWindow === undefined ? 'auto' : CONTEXT_WINDOW_PRESETS.some(item => item.tokens === initialWindow) ? String(initialWindow) : 'other')
const windowOptions = [
  { value: 'auto', label: t.settings.budgetAuto },
  ...CONTEXT_WINDOW_PRESETS.map(item => ({ value: String(item.tokens), label: item.label + ' · ' + item.tokens.toLocaleString() + ' Token' })),
  { value: 'other', label: t.settings.budgetOther },
]
const thresholdOptions = COMPACTION_THRESHOLDS.map(value => ({ value: String(value), label: t.settings.thresholdOption(value) }))
const selectedWindow = computed(() => windowChoice.value === 'auto' ? undefined : windowChoice.value === 'other' ? Number(form.contextWindow) : Number(windowChoice.value))
const validWindow = computed(() => selectedWindow.value === undefined || Number.isInteger(selectedWindow.value)
  && selectedWindow.value >= MODEL_BUDGET_BOUNDS.contextWindow.min && selectedWindow.value <= MODEL_BUDGET_BOUNDS.contextWindow.max)
const reasoning = ref<ResolvedReasoning | null>(null)
const reasoningError = ref('')
const reasoningOptions = computed(() => (reasoning.value?.supported ?? COMMON_REASONING_EFFORTS).map(value => ({ value, label: t.reasoning.labels[value] })))
watch([() => form.baseUrl, () => form.model], (_value, _old, cleanup) => {
  let active = true
  reasoning.value = null; reasoningError.value = ''
  void call('settings:reasoning', { baseUrl: form.baseUrl.trim(), model: form.model.trim() })
    .then(value => { if (active) reasoning.value = value })
    .catch(e => { if (active) reasoningError.value = (e as Error).message })
  cleanup(() => { active = false })
}, { immediate: true })
const preview = ref<ResolvedModelBudget | null>(null)
const previewError = ref('')
const testing = ref(false)
const result = ref<{ ok: boolean; text: string } | null>(null)
const saved = ref(false)
const saving = ref(false)
const error = ref('')
const snapshot = () => JSON.stringify({ ...form, windowChoice: windowChoice.value })
let baseline = snapshot()
let syncing = false
// 仅无修改时同步其他入口保存的模型值，分类切换继续保留草稿。
watch(() => app.settings?.model, async value => {
  if (!value || saving.value || snapshot() !== baseline) return
  syncing = true
  form.baseUrl = value.baseUrl; form.model = value.model; form.reasoningEffort = value.reasoningEffort
  form.contextWindow = value.contextWindow ?? ''
  form.threshold = String(value.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD)
  windowChoice.value = value.contextWindow === undefined ? 'auto' : CONTEXT_WINDOW_PRESETS.some(item => item.tokens === value.contextWindow) ? String(value.contextWindow) : 'other'
  await nextTick()
  baseline = snapshot(); syncing = false
})
watch([() => form.baseUrl, () => form.model], () => { if (!syncing) { windowChoice.value = 'auto'; form.contextWindow = ''; form.reasoningEffort = 'auto' } })
watch(windowChoice, value => {
  if (value !== 'auto' && value !== 'other') form.contextWindow = Number(value)
})
// 编辑中的预算不落盘，复用主进程同一解析逻辑；只展示最后一份输入的结果。
watch([() => form.baseUrl, () => form.model, selectedWindow, () => form.threshold, () => form.reasoningEffort], (_values, _old, cleanup) => {
  let active = true
  preview.value = null; previewError.value = ''
  if (!validWindow.value) return
  const input = { baseUrl: form.baseUrl.trim(), model: form.model.trim(), contextWindow: selectedWindow.value, compactionThreshold: Number(form.threshold) as CompactionThreshold, reasoningEffort: form.reasoningEffort as ReasoningEffort }
  const timer = setTimeout(() => {
    void call('settings:modelBudget', input).then(value => { if (active) preview.value = value })
      .catch(e => { if (active) previewError.value = (e as Error).message })
  }, 250)
  cleanup(() => { active = false; clearTimeout(timer) })
}, { immediate: true })

async function test(): Promise<void> {
  testing.value = true
  result.value = null
  if (!validWindow.value) { result.value = { ok: false, text: t.settings.invalidContextWindow }; testing.value = false; return }
  try {
    const r = await call('settings:testModel', {
      baseUrl: form.baseUrl.trim() || undefined,
      model: form.model.trim() || undefined,
      apiKey: form.apiKey || undefined,
      reasoningEffort: form.reasoningEffort, contextWindow: selectedWindow.value, compactionThreshold: Number(form.threshold) as CompactionThreshold,
    })
    result.value = { ok: r.ok, text: r.ok ? t.onboarding.testOk(r.latencyMs ?? 0) : (r.message ?? '') }
  } catch (e) {
    result.value = { ok: false, text: e instanceof ApiError ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  if (saving.value) return
  saved.value = false; error.value = ''
  if (!validWindow.value) { error.value = t.settings.invalidContextWindow; return }
  saving.value = true
  try {
    await app.updateSettings({
      model: { baseUrl: form.baseUrl, model: form.model, ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        contextWindow: selectedWindow.value ?? null, compactionThreshold: Number(form.threshold) as CompactionThreshold, reasoningEffort: form.reasoningEffort as ReasoningEffort },
    })
    form.apiKey = ''
    await nextTick()
    baseline = snapshot()
    saved.value = true
    setTimeout(() => (saved.value = false), 2000)
  } catch (e) { error.value = (e as Error).message }
  finally { saving.value = false }
}
</script>

<template>
  <div class="model-form">
    <label>
      <span>{{ t.onboarding.baseUrl }}</span>
      <input v-model="form.baseUrl" type="text" data-testid="model-base-url" placeholder="https://…/v1" />
    </label>
    <label>
      <span>{{ t.onboarding.apiKey }}</span>
      <input v-model="form.apiKey" type="password" data-testid="model-api-key" :placeholder="app.settings?.model.hasApiKey ? t.settings.apiKeyKeep : ''" />
    </label>
    <label>
      <span>{{ t.onboarding.model }}</span>
      <input v-model="form.model" type="text" data-testid="model-name" />
    </label>
    <details class="model-advanced" data-testid="model-advanced">
      <summary>{{ t.settings.modelAdvanced }}</summary>
      <div class="model-field"><span>{{ t.reasoning.title }}</span><AppSelect v-model="form.reasoningEffort" :options="reasoningOptions" :label="t.reasoning.title" data-testid="model-reasoning-effort" /></div>
      <p class="small muted">{{ t.reasoning.hint }}</p>
      <p v-if="reasoning?.availability === 'unverified'" class="small muted" data-testid="model-reasoning-unverified">{{ t.reasoning.unverified }}</p>
      <p v-if="reasoningError" class="small bad" role="alert">{{ reasoningError }}</p>
      <p class="small muted">{{ t.settings.budgetHint }}</p>
      <div class="model-field"><span>{{ t.settings.contextWindow }}</span><AppSelect v-model="windowChoice" :options="windowOptions" :label="t.settings.contextWindow" data-testid="model-context-window" /></div>
      <label v-if="windowChoice === 'other'"><span>{{ t.settings.contextExact }}</span><input v-model="form.contextWindow" type="number" :min="MODEL_BUDGET_BOUNDS.contextWindow.min" :max="MODEL_BUDGET_BOUNDS.contextWindow.max" step="1" data-testid="model-context-custom" /></label>
      <p v-if="preview" class="small muted" data-testid="model-budget-preview">{{ t.settings.resolvedWindow(preview.contextWindow, t.agent.contextSources[preview.source]) }}</p>
      <p v-else-if="previewError" class="small bad" role="alert">{{ previewError }}</p>
      <div class="model-field"><span>{{ t.settings.compactionThreshold }}</span><AppSelect v-model="form.threshold" :options="thresholdOptions" :label="t.settings.compactionThreshold" data-testid="model-compaction-threshold" /></div>
      <p class="small muted">{{ t.settings.compactionHint }}</p>
    </details>
    <p v-if="error" class="small bad" role="alert" data-testid="model-save-error">{{ error }}</p>
    <div class="row">
      <button data-testid="model-test" :disabled="testing" @click="test">{{ testing ? t.onboarding.testing : t.onboarding.test }}</button>
      <button data-testid="model-save" :disabled="saving" @click="save">{{ t.settings.save }}</button>
      <span v-if="saved" class="small muted">{{ t.settings.saved }}</span>
      <span v-if="result" class="small selectable" :class="result.ok ? 'ok' : 'bad'" data-testid="model-test-result" :data-ok="result.ok">{{ result.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.model-form { display:flex; flex-direction:column; gap:var(--space-3); }
label, .model-field { display:grid; grid-template-columns:88px minmax(0,1fr); align-items:center; gap:var(--space-2); }
.row { display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap; }
.ok { color:var(--success); }
.bad { color:var(--danger); }
.model-advanced { display:grid; gap:var(--space-3); border-top:1px solid var(--border); padding-top:var(--space-3); }
.model-advanced summary { cursor:pointer; color:var(--text-muted); font-size:var(--font-size-small); }
.model-advanced[open] > :not(summary) { margin-top:var(--space-3); }
.model-advanced p { line-height:1.7; }
.model-advanced input { min-width:0; width:100%; }
@container content (max-width:450px) { label, .model-field { grid-template-columns:minmax(0,1fr); gap:var(--space-1); } }
</style>
