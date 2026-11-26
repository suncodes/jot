<script setup lang="ts">
import { Clock, Send, X } from 'lucide-vue-next'
import { nextTick, reactive, ref } from 'vue'
import { invoke } from '@/api'
import DateTimeField from '@/components/DateTimeField.vue'
import { t } from '@/strings'
const { source } = defineProps<{ source: 'quick-capture' | 'main-window' }>()
const emit = defineEmits<{ saved: [path: string]; cancel: []; resize: [] }>()
const text = ref('')
const error = ref('')
const busy = ref(false)
const timeOpen = ref(false)
const dateValidity = reactive({ start: true, end: true })
const start = ref('')
const end = ref('')
const el = ref<HTMLTextAreaElement | null>(null)
function fit(): void {
  const ta = el.value
  if (!ta) return
  ta.style.height = 'auto'
  const line = parseFloat(getComputedStyle(ta).lineHeight)
  ta.style.height = Math.min(ta.scrollHeight, line * 6) + 'px'
  emit('resize')
}
function clearTime(): void { dateValidity.start = dateValidity.end = true; start.value = ''; end.value = ''; timeOpen.value = false; error.value = ''; emit('resize') }
async function save(): Promise<void> {
  if (busy.value) return
  if (!text.value.trim()) { emit('cancel'); return }
  if (!dateValidity.start || !dateValidity.end) { error.value = t.controls.invalidDate; return }
  if (!!start.value !== !!end.value) { error.value = t.library.incompleteTime; return }
  if (start.value && (Number.isNaN(Date.parse(start.value)) || Number.isNaN(Date.parse(end.value)) || Date.parse(end.value) < Date.parse(start.value))) {
    error.value = t.library.badTime; return
  }
  busy.value = true
  const r = start.value && end.value
    ? await invoke('capture:saveLog', { text: text.value, start: new Date(start.value).toISOString(), end: new Date(end.value).toISOString() })
    : await invoke('capture:save', { text: text.value, source })
  busy.value = false
  if (!r.ok) { error.value = `${t.capture.saveFailed}：${r.error.message}`; await nextTick(fit); return }
  text.value = ''; error.value = ''; clearTime()
  await nextTick(fit)
  emit('saved', r.data.path)
}
function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save() }
  else if (e.key === 'Escape') { e.preventDefault(); emit('cancel') }
}
defineExpose({ focus: () => el.value?.focus(), isEmpty: () => !text.value.trim() })
</script>
<template>
  <div class="capture" :class="{ compact: source === 'quick-capture' }">
    <div class="capture-box"><textarea ref="el" v-model="text" rows="1" data-testid="capture-input" :placeholder="t.library.recordPlaceholder" @input="fit" @keydown="onKeydown" /><button class="primary save" :disabled="busy || !text.trim()" data-testid="capture-save" @click="save"><Send :size="14" /><span>{{ busy ? t.library.saving : t.library.save }}</span></button></div>
    <div v-if="source === 'main-window'" class="capture-tools small"><button class="ghost time-toggle" :aria-expanded="timeOpen" data-testid="capture-time" @click="timeOpen = !timeOpen; emit('resize')"><Clock :size="12" />{{ t.library.timeRange }}</button><span class="faint">{{ t.library.captureHint }}</span></div>
    <div v-if="timeOpen" class="times small"><DateTimeField v-model="start" :label="t.today.logStart" testid="capture-start" @validity="dateValidity.start = $event" /><DateTimeField v-model="end" :label="t.today.logEnd" testid="capture-end" @validity="dateValidity.end = $event" /><button class="ghost icon-button" :title="t.library.clearTime" data-testid="capture-clear-time" @click="clearTime"><X :size="14" /></button></div>
    <div v-if="error" class="error small selectable" role="alert" data-testid="capture-error">{{ error }}</div>
  </div>
</template>
<style scoped>
.capture { max-width:var(--page-width); margin:0 auto; }
.capture-box { display:flex; align-items:flex-end; gap:var(--space-3); padding:var(--space-3); border:1px solid var(--border); border-radius:var(--radius-m); background:var(--canvas); }
.capture-box:focus-within { border-color:var(--accent); }
textarea { flex:1; min-width:0; width:100%; resize:none; border:0; background:transparent; padding:0; line-height:24px; font-size:var(--font-size-ui); overflow-y:auto; }
.save { display:flex; align-items:center; gap:var(--space-2); flex:none; font-size:var(--font-size-small); min-height:30px; padding:var(--space-1) var(--space-3); }
.capture-tools { display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); margin-top:var(--space-1); }
.time-toggle { display:flex; align-items:center; gap:var(--space-1); padding:0; min-height:24px; font-size:inherit; color:var(--text-muted); }
.times { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)) auto; align-items:end; gap:var(--space-3); padding-top:var(--space-2); }

.error { margin-top:var(--space-1); color:var(--danger); }
.compact .capture-box { border:0; padding:0; background:transparent; }
@container content (max-width:650px) { .times { grid-template-columns:minmax(0,1fr) auto; } .times > .date-time-field { grid-column:1; } .times > button { grid-column:2; grid-row:1 / 3; align-self:center; } }
@container content (max-width:600px) { .capture-tools > span { display:none; } }
</style>
