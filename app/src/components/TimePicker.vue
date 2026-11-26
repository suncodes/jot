<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppSelect from '@/components/AppSelect.vue'
import { t } from '@/strings'

const { label, testid, clearable = true, disabled = false } = defineProps<{
  label: string
  testid: string
  clearable?: boolean
  disabled?: boolean
}>()
const value = defineModel<string>({ required: true })
// 设置通过 IPC 保存，先在本地同步已选择的时分。
const draft = ref(value.value)
watch(value, (next) => { draft.value = next })
const options = (count: number) => Array.from({ length: count }, (_, n) => {
  const text = String(n).padStart(2, '0')
  return { value: text, label: text }
})
const hours = computed(() => [...(clearable ? [{ value: '', label: t.controls.hourPlaceholder }] : []), ...options(24)])
const minutes = computed(() => [...(clearable ? [{ value: '', label: t.controls.minutePlaceholder }] : []), ...options(60)])

function setPart(part: 0 | 1, next: string): void {
  const parts = draft.value.split(':')
  parts[part] = next
  draft.value = next ? (parts[0] || '00') + ':' + (parts[1] || '00') : ''
  value.value = draft.value
}
const hour = computed({ get: () => draft.value.split(':')[0] ?? '', set: (next: string) => setPart(0, next) })
const minute = computed({ get: () => draft.value.split(':')[1] ?? '', set: (next: string) => setPart(1, next) })
</script>

<template>
  <div class="time-picker" role="group" :aria-label="label" :data-testid="testid" :data-value="draft">
    <AppSelect v-model="hour" :options="hours" :label="label + ' · ' + t.controls.hour" :disabled :data-testid="testid + '-hour'" />
    <span class="separator" aria-hidden="true">:</span>
    <AppSelect v-model="minute" :options="minutes" :label="label + ' · ' + t.controls.minute" :disabled :data-testid="testid + '-minute'" />
  </div>
</template>

<style scoped>
.time-picker { display:inline-flex; align-items:center; justify-self:start; gap:var(--space-1); min-width:0; font-variant-numeric:tabular-nums; }
.time-picker .app-select { width:72px; flex:none; }
.separator { width:6px; text-align:center; color:var(--text-muted); }
</style>
