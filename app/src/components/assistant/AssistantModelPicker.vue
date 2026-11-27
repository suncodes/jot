<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { Check, ChevronDown, Search } from 'lucide-vue-next'
import { call } from '@/api'
import { usePopover } from '@/composables/usePopover'
import { useAppStore } from '@/stores/app'
import { t } from '@/strings'
import { modelOptions, resolveModelSettings } from '@shared/models'
import { COMMON_REASONING_EFFORTS, reasoningModelKey, type ReasoningEffort } from '@shared/reasoning'
import type { AssistantContext } from '@shared/assistant'

const { context, busy, loading } = defineProps<{ context: AssistantContext; busy: boolean; loading: boolean }>()
const emit = defineEmits<{ context: [value: AssistantContext]; open: [] }>()
const app = useAppStore()
const { anchor, panel, open, position, show, close, toggle } = usePopover(330)
const panelPosition = computed(() => ({ ...position.value, maxHeight: Math.min(380, Number.parseFloat(String(position.value.maxHeight ?? 380))) + 'px' }))
const selectedModel = computed(() => app.settings && resolveModelSettings(app.settings.models, context.modelId ?? app.settings.models.defaultModelId))
const modelIdentity = computed(() => selectedModel.value ? reasoningModelKey(selectedModel.value) : '')
const modelChoice = computed(() => context.modelId ?? 'follow')
const modelLabel = computed(() => selectedModel.value ? selectedModel.value.name || selectedModel.value.model : context.modelId ? '模型已删除' : '选择模型')
const modelTitle = computed(() => selectedModel.value ? selectedModel.value.channelName + ' / ' + modelLabel.value : modelLabel.value)
const effort = computed(() => context.reasoningEffort ?? selectedModel.value?.reasoningEffort ?? 'auto')
const locked = computed(() => busy || loading)
const supported = ref<readonly ReasoningEffort[]>(COMMON_REASONING_EFFORTS)
const resolving = ref(false), error = ref(''), query = ref('')
const search = ref<HTMLInputElement | null>(null)
const active = ref(0), id = useId()
const choices = computed(() => {
  if (!app.settings) return []
  const global = resolveModelSettings(app.settings.models)
  return [
    { value: 'follow', label: '跟随全局 · ' + (global ? global.channelName + ' / ' + (global.name || global.model) : '未配置'), group: '' },
    ...modelOptions(app.settings.models),
  ].filter(option => option.label.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()))
})
const unadjustable = computed(() => supported.value.length === 1 && supported.value[0] === 'auto')
async function expand(): Promise<void> {
  if (locked.value) return
  if (open.value) { toggle(); return }
  emit('open')
  query.value = ''; active.value = Math.max(0, choices.value.findIndex(item => item.value === modelChoice.value))
  await show()
  search.value?.focus()
}
function chooseModel(value: string): void {
  if (locked.value) return
  if (value !== modelChoice.value) {
    const { modelId: _id, reasoningEffort: _effort, reasoningModel: _identity, ...rest } = context
    emit('context', { ...rest, ...(value === 'follow' ? {} : { modelId: value }) })
  }
}
function chooseEffort(value: ReasoningEffort): void {
  if (locked.value || resolving.value || !selectedModel.value || !supported.value.includes(value)) return
  const { reasoningEffort: _effort, reasoningModel: _identity, ...rest } = context
  // 选回该模型的配置值时恢复继承，界面始终显示实际档位。
  emit('context', value === selectedModel.value.reasoningEffort ? rest : { ...rest, reasoningEffort: value, reasoningModel: modelIdentity.value })
  close(true)
}
function keyboard(event: KeyboardEvent): void {
  if (event.isComposing || locked.value || (event.target instanceof HTMLElement && event.target.closest('.effort-options'))) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (choices.value.length) active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + choices.value.length) % choices.value.length
    void nextTick(() => {
      const option = document.getElementById(id + '-' + active.value)
      option?.scrollIntoView({ block: 'nearest' })
      if (event.target !== search.value) option?.focus()
    })
  } else if (event.key === 'Enter' && event.target === search.value) {
    event.preventDefault()
    const option = choices.value[active.value]
    if (option) chooseModel(option.value)
  }
}
watch(query, () => { active.value = 0 })
watch(() => busy, value => { if (value) close() })
watch(modelIdentity, (_value, _old, cleanup) => {
  let active = true
  cleanup(() => { active = false })
  const model = selectedModel.value
  supported.value = COMMON_REASONING_EFFORTS; error.value = ''; resolving.value = !!model
  if (!model) return
  void call('settings:reasoning', { baseUrl: model.baseUrl, model: model.model, protocol: model.protocol })
    .then(value => { if (active) supported.value = value.supported })
    .catch(cause => { if (active) error.value = (cause as Error).message })
    .finally(() => { if (active) resolving.value = false })
}, { immediate: true })
</script>
<template>
  <div ref="anchor" class="assistant-model-picker">
    <button type="button" class="ghost model-picker-trigger" :title="modelTitle + (selectedModel ? ' · ' + t.reasoning.labels[effort] : '')" :aria-label="t.reasoning.details" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="open ? id : undefined" :disabled="locked" data-testid="agent-model-settings" @click="expand" @keydown.down.prevent="expand" @keydown.up.prevent="expand">
      <span class="model-label" data-testid="agent-model" :data-value="modelChoice">{{ modelLabel }}</span><template v-if="selectedModel"><span class="model-divider" aria-hidden="true">·</span><span class="effort-label" data-testid="agent-reasoning-effort" :data-value="effort">{{ t.reasoning.labels[effort] }}</span></template><ChevronDown :size="10" aria-hidden="true" />
    </button>
    <Teleport to="body">
      <section v-if="open" :id="id" ref="panel" class="model-picker-panel" :style="panelPosition" role="dialog" :aria-label="t.reasoning.details" data-testid="agent-model-picker" @keydown="keyboard">
        <label class="model-search"><Search :size="14" /><input ref="search" v-model="query" type="text" placeholder="搜索渠道或模型" aria-label="搜索对话模型" :aria-controls="id + '-models'" :aria-activedescendant="choices.length ? id + '-' + active : undefined" data-testid="agent-model-search" /></label>
        <div :id="id + '-models'" class="model-options" role="listbox" aria-label="对话模型" data-testid="agent-model-options">
          <template v-for="(option, index) in choices" :key="option.value">
            <div v-if="option.group && (index === 0 || choices[index - 1]?.group !== option.group)" class="model-group">{{ option.group }}</div>
            <button :id="id + '-' + index" type="button" class="ghost model-option" :class="{ active: active === index }" role="option" :data-value="option.value" :aria-selected="option.value === modelChoice" :disabled="locked" @pointermove="active = index" @focus="active = index" @click="chooseModel(option.value)"><span>{{ option.label }}</span><Check v-if="option.value === modelChoice" :size="13" /></button>
          </template>
          <p v-if="!choices.length" class="empty-models">没有匹配的模型</p>
        </div>
        <div class="model-effort">
          <span class="effort-heading">{{ t.reasoning.title }}</span>
          <p v-if="!selectedModel" class="effort-note">请先选择一个可用模型。</p>
          <p v-else-if="resolving" class="effort-note" role="status">{{ t.reasoning.loading }}</p>
          <p v-else-if="error" class="effort-error" role="alert">{{ error }}</p>
          <p v-else-if="unadjustable && effort === 'auto'" class="effort-note">此模型不提供推理档位，不发送强度参数。</p>
          <div v-else class="effort-options" role="group" :aria-label="t.reasoning.title" data-testid="agent-reasoning-options">
            <button v-for="value in supported" :key="value" type="button" class="ghost effort-option" :data-value="value" :aria-pressed="effort === value" :disabled="locked" @click="chooseEffort(value)">{{ t.reasoning.labels[value] }}</button>
          </div>
        </div>
      </section>
    </Teleport>
  </div>
</template>
<style scoped>
.assistant-model-picker { flex:1 1 auto; min-width:0; }
.model-picker-trigger { display:flex; align-items:center; gap:5px; max-width:100%; min-width:0; padding:6px; font-size:11px; color:var(--text-normal); }
.model-picker-trigger svg, .model-divider, .effort-label { flex:none; }
.model-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.model-divider { color:var(--text-faint); }
.model-picker-panel { z-index:200; display:flex; flex-direction:column; min-height:0; overflow:hidden; border:1px solid var(--border); border-radius:var(--radius-m); background:var(--bg-primary); box-shadow:var(--shadow); font-size:var(--font-size-small); }
.model-search { display:flex; align-items:center; gap:8px; flex:none; padding:10px 12px; border-bottom:1px solid var(--border); color:var(--text-muted); }
.model-search input { flex:1; min-width:0; width:100%; background:transparent; border:0; outline:0; padding:0; box-shadow:none; }
.model-options { overflow:auto; min-height:40px; padding:4px; }
.model-group { padding:8px 8px 4px; color:var(--text-faint); font-size:11px; }
.model-option { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; padding:8px; text-align:left; font-size:inherit; border-radius:var(--radius-s); }
.model-option span { min-width:0; overflow-wrap:anywhere; }
.model-option svg { flex:none; }
.model-option.active { background:var(--bg-hover); }
.model-option[aria-selected="true"] { color:var(--accent); background:var(--accent-soft); }
.model-effort { flex:none; padding:10px 12px; border-top:1px solid var(--border); }
.effort-heading { display:block; margin-bottom:8px; color:var(--text-muted); font-size:11px; }
.effort-options { display:flex; flex-wrap:wrap; gap:4px; }
.effort-option { flex:1 0 auto; padding:4px 8px; border-radius:var(--radius-s); font-size:12px; }
.effort-option[aria-pressed="true"] { color:var(--accent); background:var(--accent-soft); }
.effort-note, .effort-error, .empty-models { margin:0; font-size:12px; color:var(--text-muted); overflow-wrap:anywhere; }
.empty-models { padding:12px 8px; }
.effort-error { color:var(--danger); }
</style>
