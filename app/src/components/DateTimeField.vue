<script setup lang="ts">
import { computed } from 'vue'
import DatePicker from '@/components/DatePicker.vue'
import TimePicker from '@/components/TimePicker.vue'
import { t } from '@/strings'

const { label, testid } = defineProps<{ label: string; testid: string }>()
const emit = defineEmits<{ validity: [valid: boolean] }>()
const value = defineModel<string>({ required: true })
// 保留未填写完整的值，交给记录保存时的校验处理，不能静默变成无时间的记录。
function join(date: string, time: string): string { return date || time ? date + 'T' + time : '' }
const date = computed({ get: () => value.value.split('T')[0] ?? '', set: (v: string) => { value.value = join(v, time.value) } })
const time = computed({ get: () => value.value.split('T')[1] ?? '', set: (v: string) => { value.value = join(date.value, v) } })
</script>

<template>
  <div class="date-time-field" :data-testid="testid">
    <span class="small muted">{{ label }}</span>
    <div class="fields"><DatePicker v-model="date" :label="label + ' · ' + t.today.pickDate" :data-testid="testid + '-date'" @validity="emit('validity', $event)" /><TimePicker v-model="time" :label="label + ' · ' + t.controls.time" :testid="testid + '-time'" /></div>
  </div>
</template>

<style scoped>
.date-time-field { display:grid; gap:var(--space-1); min-width:0; }
.fields { display:grid; grid-template-columns:minmax(0,1fr) 158px; gap:var(--space-2); }
.fields .date-picker { width:100%; }
</style>
