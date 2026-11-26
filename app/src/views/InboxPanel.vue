<script setup lang="ts">
import { ArrowLeft, ArrowUpRight, Inbox } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { DocMeta, InboxItem } from '@shared/types'
import { call, on } from '@/api'
import Pager from '@/components/Pager.vue'
import DocView from '@/views/DocView.vue'
import InboxDecision from '@/components/InboxDecision.vue'
import { useTabsStore, type Tab } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'

// 目录归档与属性建议在主内容区独立处理，侧栏继续用于浏览。
const { active } = defineProps<{ active: boolean }>()
const tabs = useTabsStore()
const toasts = useToastsStore()
const items = ref<InboxItem[]>([])
const selected = ref(0)
const page = ref(1)
const total = ref(0)
const size = 25
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const actionError = ref('')
const mobileDetail = ref(false)
const root = ref<HTMLDivElement | null>(null)
const detail = ref<InstanceType<typeof DocView> | null>(null)
const current = computed(() => items.value[selected.value])
const detailTab = computed<Tab | null>(() => current.value ? { key: current.value.doc.path, path: current.value.doc.path, title: current.value.doc.title, lineTick: 0 } : null)
const offs: (() => void)[] = []
let timer: ReturnType<typeof setTimeout> | undefined
let sequence = 0

async function refresh(): Promise<void> {
  const mine = ++sequence
  const keep = current.value?.doc.path
  loading.value = true
  try {
    const inbox = await call('classify:inbox', { limit: size, offset: (page.value - 1) * size })
    if (mine !== sequence) return
    // 人工改属性可能让当前条目离开待整理，先保存正文再切换详情。
    if (keep && !inbox.items.some((item) => item.doc.path === keep)) {
      await detail.value?.flush()
      if (mine !== sequence || detail.value?.dirty) return
    }
    total.value = inbox.total
    const last = Math.max(1, Math.ceil(inbox.total / size))
    if (page.value > last) { page.value = last; return }
    items.value = inbox.items
    const i = items.value.findIndex((x) => x.doc.path === keep)
    selected.value = i >= 0 ? i : Math.min(selected.value, Math.max(items.value.length - 1, 0))
    if (!items.value.length) mobileDetail.value = false
    error.value = ''
  } catch (e) { if (mine === sequence) error.value = (e as Error).message }
  finally { if (mine === sequence) loading.value = false }
}
function refreshSoon(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void refresh(), 100)
}
async function select(i: number): Promise<void> {
  if (busy.value || !items.value[i]) return
  if (i !== selected.value) {
    await detail.value?.flush()
    if (detail.value?.dirty) return
  }
  selected.value = i
  mobileDetail.value = true
  void nextTick(() => root.value?.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' }))
}
async function act(fn: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    await detail.value?.flush()
    if (detail.value?.dirty) return
    await fn()
    await refresh()
  } catch (e) { actionError.value = (e as Error).message }
  finally { busy.value = false }
}
async function accept(item: InboxItem, kind = item.suggestions[0]?.kind, toDir?: string): Promise<void> {
  if (!kind) return
  await act(async () => {
    const meta: DocMeta = await call('classify:accept', { ref: { path: item.doc.path }, kind, ...(toDir ? { toDir } : {}) })
    if (meta.path !== item.doc.path) tabs.retarget(item.doc.path, meta.path)
    if (meta.notUpdated?.length) toasts.error(t.library.linksNotUpdated + meta.notUpdated.map(item => item.path).join('、'))
  })
}
const skip = (item: InboxItem, kind = item.suggestions[0]?.kind) => kind && act(() => call('classify:skip', { ref: { path: item.doc.path }, kind }))
function edit(item: InboxItem): void {
  if (item.doc.role === 'source') {
    void tabs.open(item.doc.path, { newTab: true })
    tabs.editProps = item.doc.path
    return
  }
  mobileDetail.value = true
  tabs.editProps = item.doc.path
  void nextTick(() => root.value?.querySelector<HTMLButtonElement>('[data-testid="props-summary"]')?.focus())
}
async function changePage(next: number): Promise<void> {
  await detail.value?.flush()
  if (detail.value?.dirty) return
  selected.value = 0
  mobileDetail.value = false
  page.value = next
}
function keyboard(e: KeyboardEvent): void {
  if (!active || busy.value || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return
  if ((e.target as HTMLElement).closest('input, textarea, button, [contenteditable="true"]')) return
  const item = current.value
  const key = e.key.toLowerCase()
  if (key === 'arrowdown') void select(Math.min(selected.value + 1, items.value.length - 1))
  else if (key === 'arrowup') void select(Math.max(selected.value - 1, 0))
  else if (item && key === 'enter' && item.suggestions.length) void accept(item)
  else if (item && key === 'e') edit(item)
  else if (item && key === 'x') void skip(item)
  else return
  e.preventDefault()
}
watch(page, () => void refresh())
watch(() => current.value?.doc.path, () => { actionError.value = '' })
onMounted(() => {
  void refresh()
  if (active) root.value?.focus()
  offs.push(on('inbox:count', refreshSoon), on('jobs:updated', refreshSoon), on('vault:changed', refreshSoon), on('storage:changed', refreshSoon))
})
onUnmounted(() => { sequence++; clearTimeout(timer); offs.forEach((off) => off()) })
</script>

<template>
  <div ref="root" class="inbox" :class="{ 'mobile-detail': mobileDetail }" tabindex="0" data-testid="inbox-panel" @keydown="keyboard">
    <header class="review-head"><span class="heading-icon"><Inbox :size="19" /></span><div><h1>{{ t.inbox.title }}</h1><p class="small muted">{{ t.inbox.intro }}</p></div></header>
    <div v-if="error" class="error small" role="alert">{{ error }} <button @click="refresh">{{ t.common.retry }}</button></div>
    <div v-else-if="!items.length" class="empty muted" data-testid="inbox-empty"><Inbox :size="28" /><span>{{ loading ? t.library.loading : t.inbox.empty }}</span></div>
    <div v-else class="review-body">
      <section class="review-list" :aria-label="t.inbox.records" :aria-busy="loading">
        <div class="list-heading small muted">{{ t.inbox.records }} · {{ total }}</div>
        <div class="list-items"><div v-for="(item, i) in items" :key="item.doc.path" class="item" :class="{ active: i === selected }" role="button" tabindex="0" :aria-pressed="i === selected" data-testid="inbox-item" :data-path="item.doc.path" @click="select(i)" @keydown.space.prevent="select(i)">
          <div class="item-title"><span class="type-badge" :class="(item.doc.type === 'file' || item.doc.type === 'source-summary') ? 'type-file' : item.doc.type === 'note' ? 'type-note' : 'type-record'">{{ (item.doc.type === 'file' || item.doc.type === 'source-summary') ? t.library.file : item.doc.type === 'note' ? t.library.note : t.library.record }}</span><span class="small faint">{{ item.doc.created.slice(0, 10) }}</span></div>
          <div class="preview small">{{ item.preview || item.doc.title }}</div>
          <div class="suggestion small" data-testid="inbox-suggestion"><span>{{ item.reasons.map(kind => t.inbox.reasons[kind]).join(' · ') }}</span></div>
        </div></div>
        <Pager :page="page" :total="total" :size="size" prefix="inbox" :disabled="loading || busy" @change="changePage" />
      </section>
      <section v-if="current && detailTab" class="review-detail" :aria-label="current.doc.title">
        <div class="detail-head"><button class="ghost mobile-back" data-testid="inbox-back" @click="mobileDetail = false"><ArrowLeft :size="14" />{{ t.inbox.back }}</button><h2>{{ current.doc.title }}</h2><button class="ghost open-content" :title="t.inbox.open" data-testid="inbox-open" @click="tabs.open(current!.doc.path, { newTab: true })"><ArrowUpRight :size="16" /></button></div>
        <div class="decision">
          <p v-if="actionError" class="error small" role="alert" data-testid="inbox-action-error">{{ actionError }}</p>
          <InboxDecision :item="current" :busy @accept="(kind, toDir) => accept(current!, kind, toDir)" @skip="kind => skip(current!, kind)" @edit="edit(current)" @analyze="act(() => call('classify:rerun', { ref: { path: current!.doc.path } }))" @cancel="act(() => call('jobs:cancel', { jobId: current!.analysis!.jobId }))" />
        </div>
        <DocView :key="detailTab.path" ref="detail" :tab="detailTab" :active="active" :read-only="current.doc.role === 'source'" embedded properties />
      </section>
    </div>
    <div v-if="items.length" class="keys small faint">{{ t.inbox.keys }}</div>
  </div>
</template>

<style scoped>
.inbox { height:100%; display:flex; flex-direction:column; min-height:0; outline:none; padding:var(--space-5) var(--space-5) 0; }
.review-head { display:flex; align-items:center; gap:var(--space-3); margin-bottom:var(--space-5); flex:none; }
.heading-icon { display:grid; place-items:center; width:40px; height:40px; background:var(--accent-soft); color:var(--accent); border-radius:var(--radius-m); }
.review-head > div { flex:1; min-width:0; }
h1 { margin:0; font-size:22px; font-weight:650; }
.review-head p { margin:var(--space-1) 0 0; }
.review-body { display:grid; grid-template-columns:minmax(210px,30%) minmax(0,1fr); flex:1; min-height:180px; border:1px solid var(--border); border-radius:var(--radius-m); overflow:hidden; }
.review-list { display:flex; flex-direction:column; min-height:0; background:var(--canvas); border-right:1px solid var(--border); }
.list-heading { padding:var(--space-3); flex:none; }
.list-items { flex:1; overflow:auto; padding:0 var(--space-2); }
.item { padding:var(--space-3); margin-bottom:var(--space-2); border:1px solid transparent; border-radius:var(--radius-m); cursor:pointer; }
.item:hover { background:var(--bg-hover); }
.item.active { background:var(--bg-primary); border-color:var(--border); }
.item-title { display:flex; justify-content:space-between; align-items:center; gap:var(--space-2); }
.preview { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; overflow-wrap:anywhere; margin:var(--space-2) 0; }
.suggestion { color:var(--accent); overflow-wrap:anywhere; }
.review-list .pager { padding:var(--space-2) var(--space-3); border-top:1px solid var(--border); }
.review-detail { display:flex; flex-direction:column; min-width:0; min-height:0; overflow:auto; }
.detail-head { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-2); padding:var(--space-4); }
h2 { flex:1; min-width:0; margin:0; font-size:var(--font-size-ui); overflow-wrap:anywhere; }
.open-content { padding:var(--space-1); display:grid; place-items:center; color:var(--text-muted); }
.decision { flex:none; padding:0 var(--space-4) var(--space-4); border-bottom:1px solid var(--border); }
.keys { flex:none; padding:var(--space-2) 0; }
.empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--space-4); }
.error { color:var(--danger); }
.mobile-back { display:none; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); }
@container content (max-width:760px) {
  .review-body { grid-template-columns:minmax(0,1fr); }
  .review-detail { display:none; }
  .mobile-detail .review-list { display:none; }
  .mobile-detail .review-detail { display:flex; }
  .mobile-back { display:flex; flex-basis:100%; padding:0; margin-bottom:var(--space-2); }
  .inbox { padding:var(--space-4) var(--space-4) 0; }
  .keys { font-size:11px; }
}
</style>
