<script setup lang="ts">
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { dayOf, parseDay } from '@/utils/dates'
import { t } from '@/strings'

const { min = '0001-01-01', max = '9999-12-31', clearable = false, loadMarks = undefined } = defineProps<{
  min?: string
  max?: string
  clearable?: boolean
  loadMarks?: (month: string) => Promise<string[]>
}>()
const value = defineModel<string>({ required: true })
const emit = defineEmits<{ choose: [value: string] }>()
const today = dayOf(new Date())
const focused = ref(parseDay(value.value) ? value.value : today)
const month = ref(focused.value.slice(0, 7))
const marked = ref(new Set<string>())
const marksError = ref(false)
const grid = ref<HTMLElement | null>(null)
let request = 0
const heading = computed(() => Number(month.value.slice(0, 4)) + ' 年 ' + Number(month.value.slice(5)) + ' 月')
const allowed = (day: string) => !!parseDay(day) && day >= min && day <= max
const cells = computed(() => {
  const first = parseDay(month.value + '-01')!
  const offset = (first.getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(first)
    date.setDate(1 - offset + i)
    const day = dayOf(date)
    return { day, number: date.getDate(), outside: day.slice(0, 7) !== month.value }
  })
})

watch(month, async (current) => {
  const mine = ++request
  marked.value = new Set()
  marksError.value = false
  if (!loadMarks) return
  try {
    const days = await loadMarks(current)
    if (mine === request) marked.value = new Set(days)
  } catch { if (mine === request) marksError.value = true }
}, { immediate: true })
watch(value, (day) => {
  if (!parseDay(day)) return
  focused.value = day
  month.value = day.slice(0, 7)
})
function choose(day: string): void {
  if (day && !allowed(day)) return
  value.value = day
  emit('choose', day)
}
function focusCurrent(): void {
  void nextTick(() => grid.value?.querySelector<HTMLButtonElement>('[data-day="' + focused.value + '"]')?.focus())
}
function focusDay(day: string): void {
  const bounded = day < min ? min : day > max ? max : day
  if (!allowed(bounded)) return
  focused.value = bounded
  month.value = bounded.slice(0, 7)
  focusCurrent()
}
function shiftMonth(delta: number, focus = false): void {
  const date = parseDay(month.value + '-01')!
  date.setMonth(date.getMonth() + delta)
  const candidate = dayOf(date)
  if (!parseDay(candidate)) return
  month.value = candidate.slice(0, 7)
  focused.value = candidate < min ? min : candidate > max ? max : candidate
  if (focus) focusCurrent()
}
function keyboard(e: KeyboardEvent): void {
  const day = parseDay(focused.value)!
  const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
  if (e.key in delta) { e.preventDefault(); day.setDate(day.getDate() + delta[e.key]!); focusDay(dayOf(day)) }
  else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    const start = (day.getDay() + 6) % 7
    day.setDate(day.getDate() + (e.key === 'Home' ? -start : 6 - start))
    focusDay(dayOf(day))
  } else if (e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault(); shiftMonth((e.key === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1), true)
  }
}
onMounted(() => {
  if (!allowed(focused.value)) focused.value = min > focused.value ? min : max
  month.value = focused.value.slice(0, 7)
})
defineExpose({ focus: focusCurrent })
</script>

<template>
  <div class="calendar-panel" data-testid="calendar">
    <header class="calendar-head">
      <strong data-testid="calendar-month" :data-month="month">{{ heading }}</strong>
      <div><button type="button" class="ghost icon-button" data-testid="calendar-prev" :aria-label="t.controls.prevMonth" :disabled="month <= min.slice(0, 7)" @click="shiftMonth(-1)"><ChevronLeft :size="16" /></button><button type="button" class="ghost icon-button" data-testid="calendar-next" :aria-label="t.controls.nextMonth" :disabled="month >= max.slice(0, 7)" @click="shiftMonth(1)"><ChevronRight :size="16" /></button></div>
    </header>
    <div class="weekdays" aria-hidden="true"><span v-for="day in t.controls.weekdays" :key="day">{{ day }}</span></div>
    <div ref="grid" class="calendar-grid" role="grid" :aria-label="heading" @keydown="keyboard">
      <div v-for="row in 6" :key="row" role="row" class="week">
        <div v-for="cell in cells.slice((row - 1) * 7, row * 7)" :key="cell.day" role="gridcell" :aria-selected="cell.day === value">
          <button type="button" class="ghost day" :class="{ selected: cell.day === value, today: cell.day === today, outside: cell.outside }" :disabled="!allowed(cell.day)" :tabindex="cell.day === focused ? 0 : -1" :aria-label="cell.day" :aria-current="cell.day === today ? 'date' : undefined" data-testid="calendar-day" :data-day="cell.day" :data-marked="marked.has(cell.day)" @focus="focused = cell.day" @click="choose(cell.day)">
            {{ cell.number }}<i v-if="marked.has(cell.day)" class="record-dot" />
          </button>
        </div>
      </div>
    </div>
    <footer><span v-if="loadMarks" class="record-legend"><i v-if="!marksError" class="record-dot" />{{ marksError ? t.controls.marksUnavailable : t.controls.hasRecords }}</span><span class="grow" /><button v-if="clearable" type="button" class="ghost" data-testid="calendar-clear" @click="choose('')">{{ t.controls.clear }}</button><button type="button" class="ghost today-button" :disabled="!allowed(today)" data-testid="calendar-today" @click="choose(today)">{{ t.today.title }}</button></footer>
  </div>
</template>

<style scoped>
.calendar-panel { padding:var(--space-3); font-size:var(--font-size-small); }
.calendar-head { display:flex; align-items:center; justify-content:space-between; padding:0 var(--space-1) var(--space-2); }
.calendar-head strong { font-size:var(--font-size-ui); font-weight:600; }
.calendar-head > div { display:flex; gap:var(--space-1); }
.calendar-head button { padding:var(--space-1); min-height:28px; }
.weekdays, .week { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); text-align:center; }
.weekdays { color:var(--text-muted); padding:var(--space-2) 0; }
.calendar-grid { display:grid; gap:2px; }
.day { width:100%; height:var(--control-height); min-height:var(--control-height); padding:0; position:relative; color:var(--text-normal); font-variant-numeric:tabular-nums; border-radius:var(--radius-s); }
.day.outside { color:var(--text-faint); }
.day.today { color:var(--accent); font-weight:650; }
.day.selected, .day.selected:hover { background:var(--accent); color:var(--on-accent); }
.day:disabled { opacity:.35; }
.record-dot { width:4px; height:4px; border-radius:50%; background:var(--accent); display:inline-block; }
.day .record-dot { position:absolute; bottom:4px; left:calc(50% - 2px); }
.day.selected .record-dot { background:var(--on-accent); }
footer { display:flex; align-items:center; gap:var(--space-1); margin-top:var(--space-3); padding-top:var(--space-2); border-top:1px solid var(--border); }
footer button { padding:var(--space-1) var(--space-2); font-size:inherit; }
.record-legend { display:flex; align-items:center; gap:var(--space-2); color:var(--text-muted); }
.grow { flex:1; }
.today-button { color:var(--accent); }
</style>
