<script setup lang="ts">
import { Activity, ArrowUpRight, FileText, Tags, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { JobInfo, JobState } from '@shared/types'
import { call, on } from '@/api'
import Pager from '@/components/Pager.vue'
import ReasoningDetails from '@/components/ReasoningDetails.vue'
import { useTabsStore } from '@/stores/tabs'
import { t } from '@/strings'

const emit = defineEmits<{ close: []; archive: []; review: [] }>()
const tabs = useTabsStore()
const jobs = ref<JobInfo[]>([])
const filter = ref<'all' | 'active' | 'waiting-model' | 'failed' | 'done'>('all')
const page = ref(1)
const total = ref(0)
const error = ref('')
const busy = ref(false)
const action = ref('')
const root = ref<HTMLElement | null>(null)
const size = 30
const filters = computed(() => [
  { value: 'all' as const, label: t.jobs.all }, { value: 'active' as const, label: t.jobs.active },
  { value: 'waiting-model' as const, label: t.jobs.states['waiting-model'] }, { value: 'failed' as const, label: t.jobs.states.failed },
  { value: 'done' as const, label: t.jobs.recent },
])
let off: (() => void) | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let sequence = 0
const opener = document.activeElement as HTMLElement | null

async function refresh(): Promise<void> {
  const mine = ++sequence
  busy.value = true
  try {
    const states: JobState[] | undefined = filter.value === 'active' ? ['queued', 'running'] : undefined
    const state = filter.value === 'all' || filter.value === 'active' ? undefined : filter.value
    const result = await call('jobs:list', { states, state, limit: size, offset: (page.value - 1) * size })
    if (mine !== sequence) return
    total.value = result.total
    const last = Math.max(1, Math.ceil(result.total / size))
    if (page.value > last) { page.value = last; return }
    jobs.value = result.items
    error.value = ''
  } catch (e) { if (mine === sequence) error.value = (e as Error).message }
  finally { if (mine === sequence) busy.value = false }
}
function refreshSoon(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void refresh(), 100)
}
async function run(job: JobInfo, kind: 'retry' | 'cancel'): Promise<void> {
  if (action.value) return
  action.value = job.jobId
  try { await call(kind === 'retry' ? 'jobs:retry' : 'jobs:cancel', { jobId: job.jobId }); await refresh() }
  catch (e) { error.value = (e as Error).message }
  finally { action.value = '' }
}
const canOpen = (job: JobInfo) => /^(ideas|content|inbox|wiki|journal)\//.test(job.target ?? '')
function openTarget(job: JobInfo): void { if (job.target) { void tabs.open(job.target, { newTab: true }); emit('close') } }
function keyboard(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); emit('close') }
  if (e.key !== 'Tab') return
  const controls = [...(root.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])]
  const first = controls[0], last = controls.at(-1)
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
}
watch(filter, () => { if (page.value === 1) void refresh(); else page.value = 1 })
watch(page, () => void refresh())
onMounted(() => {
  void refresh()
  void nextTick(() => root.value?.querySelector<HTMLButtonElement>('[data-testid="jobs-close"]')?.focus())
  off = on('jobs:updated', refreshSoon)
})
onUnmounted(() => { off?.(); clearTimeout(timer); if (opener?.isConnected) opener.focus() })
</script>

<template>
  <div class="jobs-overlay" @mousedown.self="emit('close')">
    <section ref="root" role="dialog" aria-modal="true" :aria-label="t.jobs.title" class="jobs-drawer" data-testid="jobs-popover" @keydown="keyboard">
      <header class="drawer-head"><div class="heading"><span class="heading-icon"><Activity :size="18" /></span><h2>{{ t.jobs.title }}</h2></div><button type="button" class="ghost icon-button" data-testid="jobs-close" :aria-label="t.common.close" @click="emit('close')"><X :size="18" /></button></header>
      <p class="intro muted small">{{ t.jobs.intro }}</p>
      <nav class="job-filters" :aria-label="t.archive.colState"><button v-for="tab in filters" :key="tab.value" type="button" class="ghost" :aria-pressed="filter === tab.value" data-testid="jobs-filter" :data-filter="tab.value" @click="filter = tab.value">{{ tab.label }}</button></nav>
      <div class="job-list" :aria-busy="busy">
        <div v-if="error" class="error small" role="alert">{{ t.jobs.loadFailed }}：{{ error }} <button @click="refresh">{{ t.common.retry }}</button></div>
        <div v-else-if="!jobs.length" class="empty muted small">{{ busy ? t.library.loading : filter === 'all' ? t.jobs.empty : t.jobs.emptyFiltered }}</div>
        <article v-for="job in jobs" :key="job.jobId" class="job" data-testid="job" :data-state="job.state">
          <div class="job-line"><strong>{{ t.jobs.types[job.type] }}</strong><span class="state small" :class="job.state">{{ t.jobs.states[job.state] }}</span></div>
          <button v-if="canOpen(job)" class="ghost target" :title="job.target" @click="openTarget(job)">{{ job.target?.split('/').pop() }}<ArrowUpRight :size="13" /></button>
          <div v-else-if="job.target" class="target muted small">{{ job.target }}</div>
          <div v-if="job.error" class="error selectable small">{{ job.error }}</div>
          <div v-else-if="job.note" class="muted selectable small" data-testid="job-note">{{ job.note }}</div>
          <details v-if="job.execution" class="job-execution small" data-testid="job-execution"><summary>{{ t.reasoning.details }}</summary><p class="selectable">{{ t.capabilities.model }}：{{ job.execution.model }}</p><p v-if="job.execution.skillId" class="selectable">{{ t.capabilities.skills }}：{{ job.execution.skillId }}</p><ReasoningDetails v-if="job.execution.reasoning" :reasoning="job.execution.reasoning" /></details>
          <div v-if="job.nextRunAt && job.state === 'waiting-model'" class="muted small">{{ t.jobs.nextRetry }} · {{ new Date(job.nextRunAt).toLocaleTimeString('zh-CN') }}</div>
          <div v-if="job.state !== 'done' && job.state !== 'cancelled'" class="operations"><button v-if="job.state !== 'running'" type="button" :disabled="!!action" data-testid="job-retry" @click="run(job, 'retry')">{{ t.common.retry }}</button><button type="button" class="ghost" :disabled="!!action" data-testid="job-cancel" @click="run(job, 'cancel')">{{ t.jobs.cancel }}</button></div>
        </article>
      </div>
      <div class="drawer-bottom"><p v-if="filter === 'done'" class="muted small">{{ t.jobs.recentHint }}</p><Pager :page="page" :total="total" :size="size" prefix="jobs" :disabled="busy" @change="page = $event" /><div class="related"><button type="button" class="ghost" data-testid="jobs-files" @click="emit('archive')"><FileText :size="15" />{{ t.archive.title }}<ArrowUpRight :size="13" /></button><button type="button" class="ghost" data-testid="jobs-review" @click="emit('review')"><Tags :size="15" />{{ t.jobs.review }}<ArrowUpRight :size="13" /></button></div></div>
    </section>
  </div>
</template>

<style scoped>
.jobs-overlay { position:fixed; inset:0; z-index:100; background:var(--overlay); }
.jobs-drawer { position:absolute; top:var(--space-4); right:var(--space-4); bottom:var(--space-4); width:min(480px,calc(100vw - var(--space-6))); display:flex; flex-direction:column; border:1px solid var(--border); border-radius:var(--radius-l); background:var(--bg-primary); box-shadow:var(--shadow); overflow:hidden; }
.drawer-head { display:flex; align-items:center; justify-content:space-between; padding:var(--space-5) var(--space-5) var(--space-2); }
.heading { display:flex; align-items:center; gap:var(--space-3); }
.heading-icon { display:grid; place-items:center; width:36px; height:36px; border-radius:var(--radius-m); background:var(--accent-soft); color:var(--accent); }
h2 { margin:0; font-size:20px; font-weight:650; }
.intro { margin:0; padding:0 var(--space-5) var(--space-4); }
.job-filters { display:flex; gap:var(--space-1); padding:0 var(--space-5) var(--space-4); flex-wrap:wrap; border-bottom:1px solid var(--border); }
.job-filters button { font-size:var(--font-size-small); padding:var(--space-1) var(--space-2); color:var(--text-muted); }
.job-filters [aria-pressed='true'] { color:var(--accent); background:var(--accent-soft); }
.job-list { flex:1; min-height:0; overflow:auto; padding:var(--space-2) var(--space-5); }
.empty { padding:var(--space-7) var(--space-2); text-align:center; }
.job { padding:var(--space-4) 0; border-bottom:1px solid var(--border); }
.job-line { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); }
.job-line strong { font-size:var(--font-size-ui); font-weight:550; }
.state { color:var(--text-muted); padding:2px var(--space-2); background:var(--bg-secondary); border-radius:var(--radius-s); }
.state.failed, .error { color:var(--danger); }
.state.waiting-model { color:var(--warning); }
.state.done { color:var(--success); }
.target { display:flex; align-items:center; gap:var(--space-2); max-width:100%; padding:var(--space-2) 0; min-height:0; overflow-wrap:anywhere; text-align:left; font-size:var(--font-size-small); }
button.target { color:var(--accent); }
.error { overflow-wrap:anywhere; margin:var(--space-2) 0; }
.job-execution { margin-top:var(--space-2); overflow-wrap:anywhere; }
.job-execution summary { cursor:pointer; color:var(--text-muted); }
.operations { display:flex; gap:var(--space-2); margin-top:var(--space-3); }
.operations button { font-size:var(--font-size-small); }
.drawer-bottom { padding:0 var(--space-5) var(--space-4); border-top:1px solid var(--border); }
.drawer-bottom p { margin:var(--space-2) 0 0; }
.related { display:flex; gap:var(--space-3); border-top:1px solid var(--border); padding-top:var(--space-3); }
.related button { display:flex; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); color:var(--text-muted); padding:var(--space-1); }
</style>
