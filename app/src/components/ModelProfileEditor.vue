<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { call } from '@/api'
import { t } from '@/strings'
import AppSelect from '@/components/AppSelect.vue'
import type { ModelEndpoint } from '@shared/model-protocol'
import type { ModelProfile } from '@shared/models'
import { COMMON_REASONING_EFFORTS, type ResolvedReasoning } from '@shared/reasoning'
import { COMPACTION_THRESHOLDS, CONTEXT_WINDOW_PRESETS, DEFAULT_COMPACTION_THRESHOLD, MODEL_BUDGET_BOUNDS, type CompactionThreshold, type ResolvedModelBudget } from '@shared/model-budget'

const profile = defineModel<ModelProfile>({ required: true })
const { endpoint } = defineProps<{ endpoint: ModelEndpoint }>()
const reasoning = ref<ResolvedReasoning | null>(null), preview = ref<ResolvedModelBudget | null>(null)
const error = ref('')
const windowChoice = ref(profile.value.contextWindow === undefined ? 'auto' : CONTEXT_WINDOW_PRESETS.some(item => item.tokens === profile.value.contextWindow) ? String(profile.value.contextWindow) : 'other')
const options = [{ value: 'auto', label: t.settings.budgetAuto }, ...CONTEXT_WINDOW_PRESETS.map(item => ({ value: String(item.tokens), label: item.label })), { value: 'other', label: t.settings.budgetOther }]
const threshold = computed({ get: () => String(profile.value.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD), set: value => { profile.value.compactionThreshold = Number(value) as CompactionThreshold } })
const effortOptions = computed(() => (reasoning.value?.supported ?? COMMON_REASONING_EFFORTS).map(value => ({ value, label: t.reasoning.labels[value] })))
watch([() => profile.value.model, () => endpoint.baseUrl, () => endpoint.protocol], () => { delete profile.value.contextWindow; profile.value.reasoningEffort = 'auto'; windowChoice.value = 'auto' })
watch(windowChoice, value => { if (value === 'auto') delete profile.value.contextWindow; else if (value !== 'other') profile.value.contextWindow = Number(value) })
watch(() => [endpoint.baseUrl, endpoint.protocol, profile.value.model, profile.value.contextWindow, profile.value.compactionThreshold, profile.value.reasoningEffort], (_value, _old, cleanup) => {
  let active = true
  const timer = setTimeout(async () => {
    try {
      const config = { baseUrl: endpoint.baseUrl, protocol: endpoint.protocol, model: profile.value.model, contextWindow: profile.value.contextWindow, compactionThreshold: profile.value.compactionThreshold, reasoningEffort: profile.value.reasoningEffort }
      const [limits, efforts] = await Promise.all([call('settings:modelBudget', config), call('settings:reasoning', { baseUrl: config.baseUrl, protocol: config.protocol, model: config.model })])
      if (active) { preview.value = limits; reasoning.value = efforts; error.value = '' }
    } catch (cause) { if (active) error.value = (cause as Error).message }
  }, 180)
  cleanup(() => { active = false; clearTimeout(timer) })
}, { immediate: true })
</script>
<template>
  <div class="model-form">
    <label><span>显示名称</span><input v-model="profile.name" type="text" placeholder="可选，如 日常助手" data-testid="model-display-name" /></label>
    <label><span>模型标识</span><input v-model="profile.model" type="text" placeholder="服务提供的模型 ID" data-testid="model-name" /></label>
    <details class="model-advanced" data-testid="model-advanced">
      <summary>{{ t.settings.modelAdvanced }}</summary>
      <div class="model-field"><span>{{ t.reasoning.title }}</span><AppSelect v-model="profile.reasoningEffort" :options="effortOptions" :label="t.reasoning.title" data-testid="model-reasoning-effort" /></div>
      <p class="small muted">{{ t.reasoning.hint }}</p>
      <p v-if="reasoning?.availability === 'unverified'" class="small muted">{{ t.reasoning.unverified }}</p>
      <div class="model-field"><span>{{ t.settings.contextWindow }}</span><AppSelect v-model="windowChoice" :options :label="t.settings.contextWindow" data-testid="model-context-window" /></div>
      <label v-if="windowChoice === 'other'"><span>{{ t.settings.contextExact }}</span><input v-model.number="profile.contextWindow" type="number" :min="MODEL_BUDGET_BOUNDS.contextWindow.min" :max="MODEL_BUDGET_BOUNDS.contextWindow.max" data-testid="model-context-custom" /></label>
      <p v-if="preview" class="small muted" data-testid="model-budget-preview">{{ t.settings.resolvedWindow(preview.contextWindow, t.agent.contextSources[preview.source]) }}</p>
      <div class="model-field"><span>{{ t.settings.compactionThreshold }}</span><AppSelect v-model="threshold" :options="COMPACTION_THRESHOLDS.map(value => ({ value: String(value), label: t.settings.thresholdOption(value) }))" :label="t.settings.compactionThreshold" data-testid="model-compaction-threshold" /></div>
      <p class="small muted">{{ t.settings.compactionHint }}</p>
      <p v-if="error" class="small bad" role="alert">{{ error }}</p>
    </details>
  </div>
</template>
<style scoped>
.model-form { display:grid; gap:var(--space-3); }
label, .model-field { display:grid; grid-template-columns:88px minmax(0, 1fr); align-items:center; gap:var(--space-3); font-size:var(--font-size-small); }
input { width:100%; min-width:0; }
.model-advanced { border-top:1px solid var(--border); padding-top:var(--space-3); }
.model-advanced[open] { display:grid; gap:var(--space-3); }
summary { color:var(--text-muted); cursor:pointer; margin-bottom:var(--space-3); }
p { margin:0; }
@media (max-width:480px) { label, .model-field { grid-template-columns:76px minmax(0, 1fr); gap:var(--space-2); } }
</style>
