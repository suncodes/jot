<script setup lang="ts">
import { ChevronLeft, ChevronRight, Clock, FileText, Lightbulb, MessageSquare, NotebookPen, ArrowUpRight, Pencil, Plus, Sparkles } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, reactive, ref, watch, type Component } from 'vue'
import type { DayView, TimelineEntry } from '@shared/types'
import { ApiError, call, invoke, on } from '@/api'
import AppDialog from '@/components/AppDialog.vue'
import DatePicker from '@/components/DatePicker.vue'
import ContentActions from '@/components/ContentActions.vue'
import ConversationActions from '@/components/ConversationActions.vue'
import TimePicker from '@/components/TimePicker.vue'
import { renderMarkdown } from '@/markdown'
import { prepareContentAction } from '@/utils/pendingEdits'
import { useAppStore } from '@/stores/app'
import { useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'

// “今天”页：概览、时间线、日总结。可以切换日期，补记做过的事。
// 见 docs/user-guide.md。
const app = useAppStore()
const tabs = useTabsStore()
const kind = ref('')
const filtered = computed(() => view.value?.entries.filter((e) => !kind.value || (kind.value === 'record' ? e.kind === 'idea' || e.kind === 'log' : e.kind === kind.value)) ?? [])
const toasts = useToastsStore()

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parseDay = (s: string) => new Date(`${s}T00:00:00`)
const today = () => dayOf(new Date())

const date = defineModel<string>('date', { required: true })
const view = ref<DayView | null>(null)
const error = ref('')
let loadSequence = 0
const fresh = reactive(new Set<string>())
const log = reactive({ open: false, busy: false, start: '', end: '', text: '', error: '' })
const offs: (() => void)[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let known: Set<string> | null = null

const isToday = computed(() => date.value === today())
const heading = computed(() => {
  const d = parseDay(date.value)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${t.today.weekdays[d.getDay()]}`
})
const hasRecords = computed(() => !!view.value?.entries.length)
const dailyPreview = computed(() => {
  const element = document.createElement('div')
  element.innerHTML = renderMarkdown(view.value?.daily?.body ?? '')
  // 首段作为概括；没有普通段落时仍能预览用户修改过的总结。
  const overview = element.querySelector('p')?.textContent?.trim() || element.textContent?.trim() || ''
  return overview.slice(0, 240)
})
const icons: Record<TimelineEntry['kind'], Component> = { idea: Lightbulb, log: Clock, file: FileText, conversation: MessageSquare, note: NotebookPen }
const keyOf = (e: TimelineEntry) => e.sourcePath ?? e.messageId ?? e.time
const clock = (iso: string) => iso.length === 10 ? t.today.allDay : iso.slice(11, 16)
const recordedLabel = (e: TimelineEntry): string => {
  if (e.basis === 'updated') return t.today.fileUpdated
  if (e.basis === 'created') return t.today.fileCreated
  if (e.basis === 'occurred' && e.time.slice(0, 10) !== e.created.slice(0, 10)) return t.today.recordedAt(e.created.slice(5, 10))
  return ''
}

async function load(): Promise<void> {
  const request = ++loadSequence
  const requestedDate = date.value
  const r = await invoke('timeline:day', { date: requestedDate })
  if (request !== loadSequence || requestedDate !== date.value) return
  if (!r.ok) { error.value = r.error.message; return }
  error.value = ''
  // 新出现的记录短暂高亮（比如刚在下方记了一条）
  const keys = new Set(r.data.entries.map(keyOf))
  if (known && view.value?.date === r.data.date) {
    for (const k of keys) {
      if (!known.has(k)) {
        fresh.add(k)
        setTimeout(() => fresh.delete(k), 2000)
      }
    }
  }
  known = keys
  view.value = r.data
}
function loadSoon(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void load(), 120)
}

function go(delta: number): void {
  const d = parseDay(date.value)
  d.setDate(d.getDate() + delta)
  date.value = dayOf(d)
}
watch(date, () => {
  known = null
  view.value = null
  error.value = ''
  void load()
})

const loadMarks = (month: string) => call('timeline:daysWithRecords', { month })

// ---------- 打开记录 ----------
function open(e: TimelineEntry, ev: MouseEvent): void {
  if (e.kind === 'conversation' && e.conversationId) {
    app.openConversation = e.conversationId
    if (app.settings?.layout.agentCollapsed) void app.updateSettings({ layout: { agentCollapsed: false } })
  } else if (e.path) {
    // 时间线上的记录在新标签页打开，“今天”页留着
    tabs.open(e.path, { newTab: true, title: e.title })
    void ev
  }
}

// ---------- 日总结 ----------
async function generate(force = false): Promise<void> {
  try {
    // 隐藏标签页中也可能正在编辑日总结；先保存再发起替换。
    if (view.value?.daily) await prepareContentAction(view.value.daily.path)
    const r = await invoke('timeline:generateDaily', { date: date.value, force })
    if (r.ok) await load()
    else if (r.error.code === 'CONFLICT') toasts.error(t.today.confirmOverwrite, { label: t.today.overwrite, run: () => generate(true) })
    else toasts.error(r.error.message)
  } catch (e) { toasts.error((e as Error).message) }
}

// ---------- 补记 ----------
function openLog(): void {
  const now = new Date()
  const last = view.value?.entries.at(-1)
  const lastTimestamp = last?.end ?? last?.time
  const lastTime = lastTimestamp && lastTimestamp.length > 10 ? clock(lastTimestamp) : ''
  const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  // 开始时间默认接着上一条记录，结束时间默认是现在
  const start = lastTime && (!isToday.value || lastTime <= nowTime) ? lastTime : `${pad(Math.max(now.getHours() - 1, 0))}:${pad(now.getMinutes())}`
  const [h = 0, m = 0] = start.split(':').map(Number)
  Object.assign(log, { open: true, start, end: isToday.value ? nowTime : `${pad(Math.min(h + 1, 23))}:${pad(m)}`, text: '', error: '' })
}
async function saveLog(): Promise<void> {
  if (log.busy || !log.text.trim()) return
  if (log.end < log.start) {
    log.error = t.today.logBadTime
    return
  }
  log.busy = true
  log.error = ''
  try {
    const iso = (time: string) => new Date(`${date.value}T${time}:00`).toISOString()
    await call('capture:saveLog', { text: log.text, start: iso(log.start), end: iso(log.end) })
    log.open = false
    await load()
  } catch (e) {
    log.error = e instanceof ApiError ? e.message : String(e)
  } finally {
    log.busy = false
  }
}

onMounted(() => {
  void load()
  offs.push(on('vault:changed', loadSoon), on('files:changed', loadSoon), on('doc:updated', loadSoon), on('jobs:updated', loadSoon), on('agent:changed', loadSoon), on('storage:changed', loadSoon), on('agent:event', (e) => e.type === 'done' && loadSoon()))
})
onUnmounted(() => {
  loadSequence++
  clearTimeout(timer)
  offs.forEach((off) => off())
})
</script>

<template>
  <div class="today" data-testid="today-view" :data-date="date">
    <div class="day-hero" data-testid="timeline-hero">
      <div class="hero-date"><strong>{{ Number(date.slice(8)) }}</strong><span>{{ date.slice(0, 7).replace('-', ' / ') }}</span></div>
      <div class="hero-copy"><p class="small muted">{{ heading }}</p><h1>{{ isToday ? t.today.title : heading }}</h1><p class="muted">{{ t.today.tagline }}</p></div>
      <button class="ghost small add-log" data-testid="today-add-log" @click="openLog"><Plus :size="14" />{{ t.today.addLog }}</button>
    </div>
    <div class="timeline-toolbar">
      <div class="timeline-filters" :aria-label="t.today.typeFilter"><button v-for="k in ['', 'record', 'note', 'file', 'conversation']" :key="k" class="ghost" :aria-pressed="kind === k" data-testid="timeline-kind" :data-kind="k" @click="kind = k">{{ k ? t.library[k as 'record' | 'note' | 'file' | 'conversation'] : t.library.allEntries }}</button></div>
      <div class="date-controls">
        <span v-if="view" class="small muted" data-testid="timeline-count">{{ t.today.entryCount(filtered.length) }}</span>
        <button v-if="!isToday" class="ghost small" data-testid="today-back" @click="date = today()">{{ t.today.backToday }}</button>
        <DatePicker v-model="date" data-testid="today-date" :label="t.today.pickDate" :display-text="heading" :clearable="false" :load-marks="loadMarks" />
        <button class="ghost icon" :title="t.today.prev" data-testid="today-prev" @click="go(-1)"><ChevronLeft :size="16" /></button>
        <button class="ghost icon" :title="t.today.next" data-testid="today-next" @click="go(1)"><ChevronRight :size="16" /></button>
      </div>
    </div>
    <div v-if="error" class="small bad" role="alert" data-testid="timeline-error">{{ t.library.loadFailed }}：{{ error }} <button class="ghost small-btn" @click="load">{{ t.common.retry }}</button></div>
    <template v-if="view">
      <div class="overview small muted" data-testid="today-overview">{{ t.today.overview(view.stats) }}</div>
      <div v-if="!filtered.length" class="empty faint" data-testid="today-empty">
        <div>{{ t.today.empty }}</div>
        <p class="small" data-testid="timeline-history-note">{{ t.today.currentFilesHint }}</p>
      </div>
      <ol v-else class="timeline-stream" data-object-list data-testid="timeline-stream" :aria-label="t.today.stream">
        <li v-for="e in filtered" :key="keyOf(e)" class="entry" :class="{ fresh: fresh.has(keyOf(e)) }" data-testid="today-entry" data-object-row :data-kind="e.kind" tabindex="0" role="button" @click="open(e, $event)" @keydown.self.enter.prevent="open(e, $event as unknown as MouseEvent)" @keydown.self.space.prevent="open(e, $event as unknown as MouseEvent)">
          <span class="time small muted">{{ clock(e.time) }}<template v-if="e.end && e.end !== e.time"><br />{{ e.end.slice(0, 10) === e.time.slice(0, 10) ? clock(e.end) : e.end.slice(5, 10) + ' ' + clock(e.end) }}</template></span>
          <div class="entry-body">
            <div class="entry-kind small muted"><component :is="icons[e.kind]" :size="13" /><span>{{ t.today.kinds[e.kind] }}</span></div>
            <h3 v-if="e.kind === 'file' || e.kind === 'note' || e.kind === 'conversation' || !e.preview">{{ e.title }}</h3>
            <div v-if="e.preview" class="preview selectable">{{ e.preview }}</div>
            <div class="entry-meta small">
              <template v-if="e.classification">

                <span v-for="tag in e.classification.tags" :key="tag" class="tag hash">#{{ tag }}</span>
              </template>
              <span v-if="recordedLabel(e)" class="faint activity-hint" :data-basis="e.basis">{{ recordedLabel(e) }}</span>
              <span v-if="e.kind === 'file'" class="faint file-hint">{{ t.today.fileHint }}</span>
            </div>
          </div>
          <ConversationActions v-if="e.kind === 'conversation' && e.conversationId" :conversation-id="e.conversationId" />
          <ContentActions v-else-if="e.path" :path="e.path" />
        </li>
      </ol>
      <section class="daily" data-object-row data-testid="today-daily" data-find-scope :data-find-title="t.today.daily">
        <div class="daily-symbol" aria-hidden="true"><Sparkles :size="20" :stroke-width="1.5" /></div>
        <div class="daily-content">
          <header class="daily-head">
            <h3>{{ t.today.daily }}</h3>
            <span v-if="view.daily" class="ai-badge">{{ t.editor.aiGenerated }}</span>
          </header>
          <p v-if="view.daily" class="daily-body selectable" data-testid="daily-body" data-find-target>{{ dailyPreview }}</p>
          <div v-if="view.dailyJob" class="small daily-notice" :class="view.dailyJob.state === 'failed' ? 'bad' : 'muted'" data-testid="daily-job" :data-state="view.dailyJob.state">
            <template v-if="view.dailyJob.state === 'waiting-model'">{{ t.today.waitingModel }}</template>
            <template v-else-if="view.dailyJob.state === 'failed'">{{ t.today.failed(view.dailyJob.error ?? '') }} <button class="ghost small-btn" @click="generate()">{{ t.common.retry }}</button></template>
            <template v-else>{{ t.today.generating }}</template>
          </div>
          <div v-else-if="!view.daily" class="no-daily">
            <button v-if="hasRecords" class="ghost generate-daily" data-testid="daily-generate" @click="generate()">{{ isToday ? t.today.generate : t.today.generateFor }}<ArrowUpRight :size="13" /></button>
            <span v-else class="small faint">{{ t.today.noDailyYet }}</span>
          </div>
        </div>
        <div v-if="view.daily" class="daily-actions">
          <button class="ghost small-btn open-daily" data-testid="daily-open" @click="tabs.open(view.daily.path, { newTab: true })">{{ t.today.openFull }}<ArrowUpRight :size="13" /></button>
          <div class="daily-secondary">
            <button class="ghost small-btn" data-testid="daily-regenerate" @click="generate()"><Sparkles :size="12" />{{ t.today.regenerate }}</button>
            <button class="ghost small-btn" data-testid="daily-edit" @click="tabs.open(view.daily.path, { newTab: true, startEditing: true })"><Pencil :size="12" />{{ t.today.edit }}</button>
            <ContentActions v-if="!view.dailyJob" :path="view.daily.path" />
          </div>
        </div>
      </section>
    </template>

    <AppDialog v-if="log.open" :title="t.today.logTitle" :busy="log.busy" @close="log.open = false">
      <form data-testid="log-dialog" @submit.prevent="saveLog">
        <div class="times">
          <div class="time-field">
            <span>{{ t.today.logStart }}</span>
            <TimePicker v-model="log.start" :label="t.today.logStart" testid="log-start" :clearable="false" :disabled="log.busy" />
          </div>
          <div class="time-field">
            <span>{{ t.today.logEnd }}</span>
            <TimePicker v-model="log.end" :label="t.today.logEnd" testid="log-end" :clearable="false" :disabled="log.busy" />
          </div>
        </div>
        <textarea v-model="log.text" class="dialog-input log-text" rows="3" autofocus data-testid="log-text"
          :aria-label="t.today.logText" :placeholder="t.today.logText" :disabled="log.busy" @keydown.ctrl.enter.prevent="saveLog" />
        <p v-if="log.error" class="dialog-error" role="alert" data-testid="log-error">{{ log.error }}</p>
        <div class="dialog-actions">
          <button type="button" class="ghost" :disabled="log.busy" @click="log.open = false">{{ t.common.cancel }}</button>
          <button type="submit" class="primary" :disabled="log.busy || !log.text.trim()" data-testid="log-save">{{ t.today.logSave }}</button>
        </div>
      </form>
    </AppDialog>
  </div>
</template>

<style scoped>
.today { height:100%; overflow:auto; padding:var(--space-6) var(--space-7) var(--space-7); }
.today > * { max-width:var(--line-width); margin-left:auto; margin-right:auto; }
.day-hero { display:flex; align-items:center; gap:var(--space-5); padding:var(--space-1) 0 var(--space-6); }
.hero-date { display:flex; flex:none; flex-direction:column; align-items:center; justify-content:center; border-right:1px solid var(--border); width:104px; height:100px; padding-right:25px; }
.hero-date strong { font:550 var(--font-size-date)/1 var(--font-ui); letter-spacing:-4px; color:var(--accent); font-variant-numeric:tabular-nums; }
.hero-date span { font-size:10px; letter-spacing:1px; color:var(--text-muted); margin-top:var(--space-2); white-space:nowrap; }
.hero-copy { min-width:0; }
.hero-copy h1 { font-size:var(--font-size-hero); font-weight:650; letter-spacing:-.8px; margin:var(--space-2) 0; line-height:1.4; }
.hero-copy p { margin:0; font-size:var(--font-size-small); }
.add-log { margin-left:auto; align-self:flex-start; display:flex; align-items:center; gap:var(--space-1); color:var(--text-muted); white-space:nowrap; }
.timeline-toolbar { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); padding-bottom:var(--space-4); border-bottom:1px solid var(--border); }
.timeline-filters, .date-controls { display:flex; align-items:center; gap:var(--space-1); }
.timeline-filters button { padding:var(--space-1) var(--space-2); font-size:var(--font-size-small); white-space:nowrap; }
.timeline-filters [aria-pressed='true'] { color:var(--accent); background:var(--accent-soft); }
.date-controls { flex-wrap:wrap; justify-content:flex-end; }
.date-controls > span { white-space:nowrap; margin-right:var(--space-2); }
.date-controls :deep(.date-picker) { width:30px; }
.date-controls :deep(.date-display) { justify-content:center; padding:0; background:transparent; border-color:transparent; }
.date-controls :deep(input) { display:none; }
.date-controls :deep(.date-display span), .date-controls :deep(.date-display svg:last-child) { display:none; }
.icon { display:grid; place-items:center; padding:var(--space-1); width:28px; }
.overview { display:flex; flex-wrap:wrap; gap:var(--space-1) var(--space-3); padding:var(--space-3) 0 0; min-height:20px; }
.empty { padding:var(--space-6) 0; }
.timeline-stream { display:flex; flex-direction:column; position:relative; gap:0; list-style:none; margin:0 auto; padding:0; }
.timeline-stream::before { content:''; position:absolute; left:49px; top:30px; bottom:34px; border-left:1px solid var(--border); pointer-events:none; }
.entry { position:relative; margin-left:76px; padding:21px 0; background:transparent; border-bottom:1px solid var(--surface-line); cursor:pointer; }
.entry::before { content:''; position:absolute; left:-31px; top:28px; width:10px; height:10px; border:2px solid var(--accent); border-radius:50%; background:var(--bg-primary); }
.entry:focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:var(--radius-s); }
.time { position:absolute; left:-76px; top:23px; width:36px; font-size:11px; line-height:1.5; font-variant-numeric:tabular-nums; }
.entry > :deep(.object-more) { position:absolute; top:var(--space-4); right:0; }
.entry-body { min-width:0; padding-right:var(--space-7); border-radius:var(--radius-s); transition:background .18s; }
.entry:hover .entry-body { background:var(--bg-secondary); }
.entry.fresh .entry-body { background:var(--accent-soft); }
.entry-kind { display:flex; align-items:center; gap:var(--space-1); margin-bottom:var(--space-2); }
.entry-kind svg { display:none; }
.entry-body h3 { font-size:var(--font-size-text); margin:0 0 var(--space-2); font-weight:600; line-height:1.6; overflow-wrap:anywhere; }
.preview { white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; font-size:var(--font-size-text); line-height:1.8; }
.entry-meta { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-1); margin-top:var(--space-3); }
.entry-meta:empty { display:none; }
.tag { padding:0 var(--space-2); border-radius:var(--radius-s); background:var(--bg-secondary); color:var(--text-muted); line-height:20px; }
.tag.hash { color:var(--accent); background:var(--accent-soft); }
.tag.pending { color:var(--text-faint); background:transparent; padding-left:0; }
.file-hint, .activity-hint { margin-left:var(--space-1); }
.daily { display:flex; align-items:flex-start; gap:var(--space-3); margin-top:var(--space-5); padding:var(--space-4) var(--space-4); border:1px solid var(--border); border-radius:var(--radius-m); background:var(--canvas); }
.daily-symbol { flex:none; color:var(--accent); padding-top:2px; }
.daily-content { flex:1; min-width:0; }
.daily-head { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-2); margin-bottom:var(--space-2); }
.daily-head h3 { margin:0; font-size:var(--font-size-ui); font-weight:600; }
.daily-body { margin:0; color:var(--text-muted); line-height:1.8; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.daily-notice { margin:var(--space-2) 0 0; }
.daily-actions { display:flex; flex:none; flex-direction:column; align-items:flex-end; gap:var(--space-1); }
.daily-secondary > :deep(.object-more) { opacity:1; }
.daily-secondary { display:flex; align-items:center; gap:var(--space-1); flex-wrap:wrap; justify-content:flex-end; }
.small-btn { display:inline-flex; align-items:center; gap:var(--space-1); padding:0 var(--space-1); font-size:var(--font-size-small); color:var(--text-muted); white-space:nowrap; }
.open-daily, .generate-daily { color:var(--accent); }
.generate-daily { display:flex; align-items:center; gap:var(--space-1); font-size:var(--font-size-small); padding:0; }
.warn { color:var(--warning); }
.bad { color:var(--danger); }
.times { display:flex; flex-wrap:wrap; gap:var(--space-4); }
.time-field { display:grid; gap:var(--space-1); font-size:var(--font-size-small); color:var(--text-muted); }
.log-text { resize:vertical; }
@container content (max-width:700px) {
  .today { padding:var(--space-5); }
  .timeline-toolbar { flex-wrap:wrap; gap:var(--space-2); }
  .date-controls { margin-left:auto; }
  .daily { flex-wrap:wrap; }
  .daily-actions { flex-direction:row; align-items:center; gap:var(--space-3); width:100%; padding-left:var(--space-6); }
}
@container content (max-width:460px) {
  .hero-date { width:80px; padding-right:var(--space-4); }
  .hero-date strong { font-size:52px; }
  .hero-copy h1 { font-size:24px; }
  .day-hero { gap:var(--space-4); flex-wrap:wrap; padding-bottom:var(--space-4); }
  .add-log { align-self:auto; }
  .entry { margin-left:65px; }
  .entry::before { left:-25px; }
  .time { left:-65px; }
  .timeline-stream::before { left:44px; }
}
</style>
