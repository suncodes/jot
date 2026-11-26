<script setup lang="ts">
import { CalendarDays } from 'lucide-vue-next'
import { computed } from 'vue'
import { call } from '@/api'
import DatePicker from '@/components/DatePicker.vue'
import { t } from '@/strings'

// 日期由外壳持有，与时间线正文共享，切换内容库或收起侧栏不会丢失。
const date = defineModel<string>({ required: true })
const dayOf = (d: Date) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
const recent = computed(() => Array.from({ length: 7 }, (_, n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return dayOf(d)
}))
const label = (day: string) => {
  const d = new Date(day + 'T00:00:00')
  const prefix = day === recent.value[0] ? t.today.title : day === recent.value[1] ? t.today.yesterday : t.today.weekdays[d.getDay()]
  return prefix + ' · ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
}
const loadMarks = (month: string) => call('timeline:daysWithRecords', { month })
</script>

<template>
  <nav class="timeline-side" data-testid="timeline-sidebar" :aria-label="t.library.timeline">
    <header><strong>{{ t.library.timeline }}</strong></header>
    <label class="date-control"><span class="small muted">{{ t.today.pickDate }}</span><DatePicker v-model="date" :label="t.today.pickDate" :clearable="false" :load-marks="loadMarks" data-testid="timeline-date" /></label>
    <div class="days">
      <template v-if="!recent.includes(date)">
        <p class="caption">{{ t.today.selectedDate }}</p>
        <div class="day selected" aria-current="date" data-testid="timeline-day" :data-day="date"><CalendarDays :size="15" /><span>{{ label(date) }}</span></div>
      </template>
      <p class="caption">{{ t.today.recentDays }}</p>
      <button v-for="day in recent" :key="day" class="ghost day" :class="{ selected: day === date }" :aria-current="day === date ? 'date' : undefined" data-testid="timeline-day" :data-day="day" @click="date = day"><CalendarDays :size="15" /><span>{{ label(day) }}</span></button>
    </div>
  </nav>
</template>

<style scoped>
.timeline-side { height:100%; min-height:0; display:flex; flex-direction:column; padding:var(--space-4) var(--space-2); }
header { padding:0 var(--space-3) var(--space-4); font-size:var(--font-size-small); }
.date-control { display:grid; gap:var(--space-2); margin:0 var(--space-3) var(--space-3); }
.days { overflow:auto; min-height:0; }
.caption { margin:var(--space-3) var(--space-3) var(--space-2); font-size:var(--font-size-small); color:var(--text-faint); }
.day { display:flex; align-items:center; gap:var(--space-2); width:100%; padding:var(--space-2) var(--space-3); margin-bottom:var(--space-1); text-align:left; color:var(--text-muted); }
.day svg { flex:none; }
.day span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.selected, .selected:hover { color:var(--accent); background:var(--accent-soft); }
</style>
