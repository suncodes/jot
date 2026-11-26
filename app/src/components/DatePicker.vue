<script setup lang="ts">
import { CalendarDays, ChevronDown } from 'lucide-vue-next'
import { ref, useId, watch } from 'vue'
import CalendarPanel from '@/components/CalendarPanel.vue'
import { usePopover } from '@/composables/usePopover'
import { parseDay } from '@/utils/dates'
import { t } from '@/strings'

defineOptions({ inheritAttrs: false })
const { label, displayText = undefined, clearable = true, min = '0001-01-01', max = '9999-12-31', loadMarks = undefined } = defineProps<{
  label: string
  displayText?: string
  clearable?: boolean
  min?: string
  max?: string
  loadMarks?: (month: string) => Promise<string[]>
}>()
const emit = defineEmits<{ validity: [valid: boolean] }>()
const value = defineModel<string>({ required: true })
const draft = ref(value.value)
const invalid = ref(false)
const errorId = useId()
const calendar = ref<InstanceType<typeof CalendarPanel> | null>(null)
const { anchor, panel, open, position, show, close } = usePopover(304)

function valid(day: string): boolean {
  return !day || (!!parseDay(day) && day >= (min || '0001-01-01') && day <= (max || '9999-12-31'))
}
watch(value, (v) => {
  draft.value = v
  invalid.value = !valid(v)
  emit('validity', !invalid.value)
  close()
})
watch(() => [min, max], () => {
  invalid.value = !valid(draft.value.trim())
  emit('validity', !invalid.value)
})
function commit(final = false): void {
  const day = draft.value.trim()
  if (!day) {
    if (clearable) value.value = ''
    else draft.value = value.value
    invalid.value = false
    emit('validity', true)
  } else if (valid(day)) {
    value.value = day
    invalid.value = false
    emit('validity', true)
  } else {
    invalid.value = final || day.length >= 10
    emit('validity', false)
  }
}
function input(e: Event): void {
  draft.value = (e.target as HTMLInputElement).value
  invalid.value = false
  commit()
}
async function expand(): Promise<void> {
  if (open.value) { close(true); return }
  await show()
  calendar.value?.focus()
}
function pick(day: string): void {
  value.value = day
  draft.value = day
  invalid.value = false
  emit('validity', true)
  close(true)
}
</script>

<template>
  <div ref="anchor" class="date-picker">
    <button v-if="displayText !== undefined" v-bind="$attrs" type="button" class="date-display ghost" :aria-label="label" aria-haspopup="dialog" :aria-expanded="open" @click="expand()" @keydown.down.prevent="expand()"><CalendarDays :size="16" /><span>{{ displayText }}</span><ChevronDown :size="13" /></button>
    <div v-else class="date-field" :class="{ opened: open, invalid }">
      <input v-bind="$attrs" type="text" inputmode="numeric" maxlength="10" :value="draft" :aria-label="label" :aria-invalid="invalid" :aria-describedby="invalid ? errorId : undefined" :placeholder="t.controls.datePlaceholder" @input="input" @blur="commit(true)" @keydown.enter.prevent="commit(true)" @keydown.down.prevent="expand()" />
      <button type="button" class="ghost" :aria-label="label" aria-haspopup="dialog" :aria-expanded="open" @click="expand()"><CalendarDays :size="15" /></button>
    </div>
    <span v-if="invalid" :id="errorId" class="date-error">{{ t.controls.invalidDate }}</span>
    <Teleport :to="anchor?.closest('dialog') ?? 'body'">
      <div v-if="open" ref="panel" role="dialog" :aria-label="label" class="date-popover" :style="position">
        <CalendarPanel ref="calendar" v-model="value" :min="min || undefined" :max="max || undefined" :clearable="clearable" :load-marks="loadMarks" @choose="pick" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.date-picker { display:inline-block; min-width:0; vertical-align:middle; }
.date-display { display:flex; align-items:center; gap:var(--space-2); min-height:var(--control-height); padding:var(--space-1) var(--space-2); }
.date-field { display:flex; align-items:center; min-height:var(--control-height); border:1px solid var(--border); border-radius:var(--radius-m); background:var(--bg-primary); }
.date-field:focus-within, .date-field.opened { border-color:var(--accent); }
.date-field.invalid { border-color:var(--danger); }
.date-field input { width:100%; min-width:0; padding:var(--space-2) 0 var(--space-2) var(--space-3); border:0; background:transparent; font-size:var(--font-size-small); }
.date-field button { display:grid; place-items:center; padding:var(--space-2); min-height:32px; flex:none; color:var(--text-muted); }
.date-error { display:block; margin-top:var(--space-1); color:var(--danger); font-size:var(--font-size-small); }
.date-popover { z-index:200; background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-l); box-shadow:var(--shadow); overflow:auto; }
</style>
