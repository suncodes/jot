<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { StorageUsage } from '@shared/maintenance'
import { call, on } from '@/api'
import AppDialog from './AppDialog.vue'
import AppSelect from './AppSelect.vue'
import { useAppStore } from '@/stores/app'
import { TRASH_TAB, useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { formatFileSize } from '@/utils/fileSize'
import { t } from '@/strings'

const { active } = defineProps<{ active: boolean }>()
const emit = defineEmits<{ history: [] }>()
const app = useAppStore()
const toasts = useToastsStore()
const usage = ref<StorageUsage | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const dialog = ref<'retention' | 'temporary' | ''>('')
const dialogError = ref('')
const c = t.maintenance
const retention = computed(() => String(app.settings?.maintenance.trashRetentionDays ?? 0))
const metrics = computed(() => usage.value ? [
  { key: 'content', label: c.content, bytes: usage.value.contentBytes },
  { key: 'derived', label: c.derived, bytes: usage.value.derivedBytes },
  { key: 'configuration', label: c.configuration, bytes: usage.value.configurationBytes },
  ...usage.value.databases.map(db => ({ key: db.kind, label: c[db.kind], bytes: db.bytes + db.walBytes })),
  { key: 'trash', label: c.trash, bytes: usage.value.trash.bytes },
] : [])
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
const offs: (() => void)[] = []
async function refresh(): Promise<void> {
  const current = ++sequence
  loading.value = true
  try {
    const data = await call('maintenance:usage')
    if (current !== sequence || !active || data.vaultPath !== app.vault.path) return
    usage.value = data
    error.value = ''
  } catch (e) { if (current === sequence) error.value = (e as Error).message }
  finally { if (current === sequence) loading.value = false }
}
function schedule(): void {
  if (!active) return
  clearTimeout(timer)
  timer = setTimeout(() => void refresh(), 150)
}
watch([() => active, () => app.vault.path], () => {
  clearTimeout(timer)
  sequence++
  if (usage.value?.vaultPath !== app.vault.path) { usage.value = null; dialog.value = '' }
  if (active) void refresh()
}, { immediate: true })

async function selectRetention(value: string): Promise<void> {
  if (value === retention.value || busy.value) return
  dialogError.value = ''
  if (value === '30') {
    await refresh()
    if (!error.value && usage.value) dialog.value = 'retention'
    return
  }
  busy.value = true
  try { await app.updateSettings({ maintenance: { trashRetentionDays: 0 } }); toasts.info(c.policySaved) }
  catch (e) { toasts.error((e as Error).message) }
  finally { busy.value = false }
}
async function confirm(): Promise<void> {
  if (busy.value || !usage.value) return
  busy.value = true; dialogError.value = ''
  try {
    if (dialog.value === 'retention') {
      await app.updateSettings({ maintenance: { trashRetentionDays: 30 } })
      toasts.info(c.policySaved)
    } else {
      const result = await call('maintenance:clearTemporary', { vaultPath: usage.value.vaultPath, confirmed: true })
      toasts.info(c.cleared(result.removed, formatFileSize(result.freedBytes)))
      if (result.failures.length) toasts.error(c.failure + result.failures.map(item => item.path + ' · ' + item.message).join('；'))
    }
    dialog.value = ''
    await refresh()
  } catch (e) { dialogError.value = (e as Error).message }
  finally { busy.value = false }
}
async function optimize(): Promise<void> {
  if (busy.value || !usage.value) return
  busy.value = true
  try {
    const result = await call('maintenance:optimizeDatabases', { vaultPath: usage.value.vaultPath })
    toasts.info(c.databaseDone(formatFileSize(result.freedBytes)))
    if (result.failures.length) toasts.error(c.failure + result.failures.map(item => c[item.database] + ' · ' + item.message).join('；'))
    await refresh()
  } catch (e) { toasts.error((e as Error).message) }
  finally { busy.value = false }
}
onMounted(() => {
  offs.push(on('agent:changed', ({ deleted }) => { if (deleted) schedule() }), on('vault:changed', schedule))
})
onUnmounted(() => { sequence++; clearTimeout(timer); offs.forEach(off => off()) })
</script>

<template>
  <section class="storage-maintenance" data-testid="storage-maintenance">
    <header><h3>{{ c.title }}</h3><button class="ghost small" :disabled="loading || busy" data-testid="storage-refresh" @click="refresh"><RefreshCw :size="13" />{{ c.refresh }}</button></header>
    <p class="small muted intro">{{ c.intro }}</p>
    <p v-if="error" class="danger small" role="alert">{{ error }} <button class="ghost small" @click="refresh">{{ t.common.retry }}</button></p>
    <p v-else-if="!usage" class="small muted">{{ c.loading }}</p>
    <dl v-if="usage" class="usage" :aria-busy="loading"><div v-for="metric in metrics" :key="metric.key" :data-testid="'storage-size-' + metric.key"><dt>{{ metric.label }}</dt><dd>{{ formatFileSize(metric.bytes) }}</dd></div></dl>
    <div class="field">
      <span>{{ c.retention }}</span>
      <div class="value"><div class="inline"><AppSelect :model-value="retention" :options="[{ value: '0', label: c.manual }, { value: '30', label: c.thirtyDays }]" :label="c.retention" :disabled="loading || busy" data-testid="storage-retention" @update:model-value="selectRetention" /><button class="ghost small" data-testid="storage-trash" @click="useTabsStore().open(TRASH_TAB, { newTab: true, title: t.trash.title })">{{ c.openTrash }}<span v-if="usage"> · {{ c.trashCount(usage.trash.items) }}</span></button></div><p class="small muted">{{ retention === '30' ? c.automaticHint : c.manualHint }}</p></div>
    </div>
    <div class="field">
      <span>{{ c.temporary }}</span>
      <div class="value"><div class="inline"><span v-if="usage" class="small muted" data-testid="storage-temporary-count">{{ c.temporaryCount(usage.temporary.files, formatFileSize(usage.temporary.bytes)) }}</span><button class="small" :disabled="loading || busy || !usage?.temporary.files" data-testid="storage-clear" @click="dialogError = ''; dialog = 'temporary'">{{ c.clear }}</button></div><p v-if="usage?.temporary.retainedFiles" class="small muted" data-testid="storage-retained">{{ c.retained(usage.temporary.retainedFiles) }}</p></div>
    </div>
    <div class="field">
      <span>{{ c.state }}</span>
      <div class="value"><button class="small" :disabled="loading || busy || !usage" data-testid="storage-optimize" @click="optimize">{{ busy ? c.optimizing : c.optimize }}</button><p class="small muted">{{ c.databaseHint }}</p><p class="small muted">{{ c.jobsHint }}</p></div>
    </div>
    <div class="field">
      <span>{{ c.history }}</span>
      <div class="value"><div class="inline"><span v-if="usage" class="small muted" data-testid="storage-conversations-count">{{ c.conversationCount(usage.conversations.count, usage.conversations.messages) }}</span><button class="ghost small" data-testid="storage-history" @click="emit('history')">{{ c.manageHistory }}</button></div><p class="small muted">{{ c.historyHint }}</p></div>
    </div>
    <AppDialog v-if="dialog" :title="dialog === 'retention' ? c.enableTitle : c.clearTitle" :busy @close="dialog = ''">
      <form @submit.prevent="confirm">
        <p>{{ dialog === 'retention' ? c.enableHint : c.clearHint }}</p>
        <p v-if="usage" class="small muted" data-testid="storage-dialog-scope">{{ dialog === 'retention' ? c.expired(usage.trash.expiredItems) : c.clearScope(usage.temporary.files, formatFileSize(usage.temporary.bytes)) }}</p>
        <p v-if="dialogError" class="dialog-error" role="alert">{{ dialogError }}</p>
        <div class="dialog-actions"><button type="button" class="ghost" :disabled="busy" @click="dialog = ''">{{ t.common.cancel }}</button><button class="primary" :disabled="busy" data-testid="storage-confirm">{{ dialog === 'retention' ? c.enable : c.clear }}</button></div>
      </form>
    </AppDialog>
  </section>
</template>
<style scoped>
header { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); }
header button { display:flex; align-items:center; gap:var(--space-1); }
h3 { margin:0; font-size:var(--font-size-ui); font-weight:600; color:var(--text-muted); }
.intro { margin:var(--space-2) 0 var(--space-4); }
.usage { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-2) var(--space-5); margin:0 0 var(--space-5); font-size:var(--font-size-small); }
.usage div { display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); }
dt { color:var(--text-muted); } dd { margin:0; white-space:nowrap; font-variant-numeric:tabular-nums; }
.field { display:grid; grid-template-columns:88px minmax(0,1fr); align-items:start; gap:var(--space-2); margin-top:var(--space-4); }
.field > span { padding-top:var(--space-2); }
.value { min-width:0; }
.value p { margin:var(--space-2) 0 0; }
.inline { display:flex; flex-wrap:wrap; align-items:center; gap:var(--space-2); }
@container content (max-width: 500px) { .usage { grid-template-columns:1fr; } .field { grid-template-columns:1fr; gap:var(--space-1); } }
</style>
