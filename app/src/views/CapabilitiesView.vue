<script setup lang="ts">
import type { RunRecord } from '@shared/assistant'
import { ArrowLeft, Copy, FolderOpen, Pencil, Plus, RefreshCw, Search } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import AppDialog from '@/components/AppDialog.vue'
import CapabilityList from '@/components/capabilities/CapabilityList.vue'
import ObjectMenu from '@/components/ObjectMenu.vue'
import Pager from '@/components/Pager.vue'
import CapabilityDetails from '@/components/capabilities/CapabilityDetails.vue'
import CapabilityEditor from '@/components/capabilities/CapabilityEditor.vue'
import ExecutionDetails from '@/components/capabilities/ExecutionDetails.vue'
import CapabilityManagerDialog from '@/components/capabilities/CapabilityManagerDialog.vue'
import PluginDetails from '@/components/capabilities/PluginDetails.vue'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { useToastsStore } from '@/stores/toasts'
import type { CapabilityPage, PreviewAgent, PreviewSkill } from '@/capabilities/model'
import { isSkillName, missingSkillTools, type AgentConfiguration, type SkillChange, type SkillImportPreview, type PluginImportPreview, type ManagedPlugin } from '@shared/capabilities'
import type { MenuAction } from '@/utils/objectActions'
import { t } from '@/strings'
import { call } from '@/api'
import { agentIcon, formatRunTime, pageIcons, toolIcon, type CapabilityRow } from '@/capabilities/presentation'
import '@/styles/capabilities.css'

const { active = true } = defineProps<{ active?: boolean }>()
const emit = defineEmits<{ use: [] }>()
const cap = useCapabilitiesStore()
const toasts = useToastsStore()
const c = t.capabilities
const search = ref<HTMLInputElement | null>(null)
const queries = reactive({ agents: '', skills: '', tools: '', plugins: '', runs: '' })
const filters = reactive({ agents: '', skills: '', tools: '', plugins: '', runs: '' })
const runPage = ref(1)
const removingRun = ref('')
const removing = ref(false)
const detailOpen = ref(cap.detailRequested)
const list = ref<InstanceType<typeof CapabilityList> | null>(null)
type Editable = 'agents' | 'skills'
const editor = ref<{ kind: Editable; item: PreviewAgent | PreviewSkill | null; mode: 'create' | 'edit' | 'copy' } | null>(null)
const confirmation = ref<{ kind: Editable; item: PreviewAgent | PreviewSkill; action: 'remove' | 'disable'; label: string; affected: string[] } | null>(null)
const filterOptions = computed(() => [{ value: '', label: c.filters.all }, ...(cap.page === 'runs'
  ? Object.entries(c.statuses).map(([value, label]) => ({ value, label }))
  : cap.page === 'tools' ? ['read', 'write', 'loader'] as const : ['enabled', 'disabled'] as const).map(option => typeof option === 'string' ? { value: option, label: c.filters[option] } : option)])
const rows = computed<CapabilityRow[]>(() => {
  const q = queries[cap.page].trim().toLocaleLowerCase()
  const filter = filters[cap.page]
  if (cap.page === 'runs') return cap.runs.map(run => ({ id: run.id, title: run.title, status: c.statuses[run.status], tone: run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : 'muted', icon: pageIcons.runs, subtitle: `${formatRunTime(run.message.startedAt ?? run.time).slice(5)} · ${run.message.context?.agent.name ?? c.defaultName}` }))
  if (cap.page === 'tools') return (cap.catalog?.tools ?? []).filter(item => (!filter || filter === item.access) && (!q || (item.title + ' ' + item.id + ' ' + item.description).toLocaleLowerCase().includes(q))).map(item => ({ id: item.id, title: item.title, status: !item.enabled ? c.disabled : item.access === 'loader' ? c.filters.loader : item.access === 'write' ? c.writable : c.readonly, tone: 'muted', icon: toolIcon(item.id) }))
  if (cap.page === 'plugins') return (cap.catalog?.plugins ?? [])
    .filter(plugin => (!filter || plugin.enabled === (filter === 'enabled')) && (!q || (plugin.name + ' ' + plugin.description).toLowerCase().includes(q)))
    .map(plugin => ({ id: plugin.id, title: plugin.name, status: !plugin.enabled ? c.disabled : plugin.issues.length ? c.needsAttention : c.enabled,
      tone: !plugin.enabled ? 'muted' : plugin.issues.length ? 'warning' : 'success', icon: pageIcons.plugins }))
  const items = cap.page === 'agents' ? cap.agents.map(item => ({ ...item, title: item.name })) : cap.skills
  return items.filter(item => (!filter || item.enabled === (filter === 'enabled')) && (!q || (item.title + ' ' + item.description).toLocaleLowerCase().includes(q))).map(item => {
    const warning = item.enabled && ('requiredTools' in item ? missingSkillTools(item, toolIds.value).length > 0 : cap.problems(item.id).length > 0)
    return { id: item.id, title: item.title, status: !item.enabled ? c.disabled : warning ? c.needsAttention : c.enabled, tone: !item.enabled ? 'muted' : warning ? 'warning' : 'success', icon: cap.page === 'agents' ? agentIcon(item.id) : pageIcons.skills }
  })
})
const toolIds = computed(() => cap.catalog?.tools.filter(tool => !tool.loader && tool.enabled).map(tool => tool.id) ?? [])
const narrowed = computed(() => !!queries[cap.page].trim() || !!filters[cap.page])
function clearFilters(): void { queries[cap.page] = ''; filters[cap.page] = ''; void nextTick(() => search.value?.focus()) }
function shortcut(e: KeyboardEvent): void {
  if (!active || e.defaultPrevented || e.isComposing || document.querySelector('dialog[open]') || (e.target as Element | null)?.closest('input, textarea, [contenteditable="true"], [data-testid="agent"]')) return
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); search.value?.focus() }
}
onMounted(() => window.addEventListener('keydown', shortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', shortcut))
const selectedRun = computed(() => cap.runs.find((run) => run.id === cap.selected))
const manager = ref<{ mode: 'plugin' | 'copy' | 'resources' | 'tasks'; id?: string; owner?: 'plugin' | 'skill' } | null>(null)
const removal = ref<{ kind: 'plugin'; id: string; affected: string[] } | null>(null)
const canCreate = computed(() => cap.page === 'agents' || cap.page === 'skills')
const importing = ref<SkillImportPreview | null>(null)
const importingPlugin = ref<PluginImportPreview | null>(null)
const pluginConfirmation = ref<ManagedPlugin | null>(null)
const importingName = ref('')
const importingBusy = ref(false)
const importNameValid = computed(() => isSkillName(importingName.value.trim())
  && (importing.value?.updating === importingName.value.trim() || !cap.skills.some(skill => !skill.pluginId && skill.name === importingName.value.trim()))
  && !(importing.value?.conflict && importingName.value.trim() === importing.value.name))
function currentItem(kind: Editable, id: string): PreviewAgent | PreviewSkill | undefined {
  return kind === 'agents' ? cap.agents.find((item) => item.id === id) : cap.skills.find((item) => item.id === id)
}
function menus(id: string): MenuAction[] {
  if (cap.page === 'runs') {
    const run = cap.runs.find(r => r.id === id)
    return [{ id: 'open-conversation', label: c.openConversation }, { id: 'view-agent', label: c.viewCurrentAgent, disabled: !cap.agents.some(a => a.id === run?.message.context?.agentId) }, { id: 'remove-run', label: c.removeRun, danger: true, separated: true }]
  }
  if (cap.page === 'tools') { const tool = cap.catalog?.tools.find(tool => tool.id === id); return [{ id: 'copy-id', label: c.copyId }, ...(!tool?.loader ? [{ id: 'toggle-tool', label: tool?.enabled ? c.disable : c.enable }] : [])] }
  if (cap.page === 'plugins') {
    const plugin = cap.catalog?.plugins.find(entry => entry.id === id)
    return plugin ? [{ id: 'toggle-plugin', label: plugin.enabled ? c.disable : c.enable }, { id: 'plugin-copy', label: c.pluginCopy },
      { id: 'resources', label: c.resources }, ...(plugin.source === 'vault' ? [{ id: 'plugin-edit', label: c.editPlugin },
        { id: 'update', label: c.updatePackage }, { id: 'uninstall', label: c.uninstall, danger: true }] : [])] : []
  }
  const kind = cap.page
  const item = currentItem(kind, id)
  if (!item) return []
  if (kind === 'agents' && item.id === 'default') return [{ id: 'edit', label: c.edit }, { id: 'copy', label: c.copy }]
  if (item.pluginId) {
    const plugin = cap.catalog?.plugins.find(plugin => plugin.id === item.pluginId)
    return [{ id: 'copy', label: c.copy }, { id: 'view-plugin', label: c.openPlugin },
      ...(kind === 'skills' ? [{ id: 'resources', label: c.resources }] : []),
      ...(plugin?.source === 'vault' ? [{ id: 'edit', label: c.edit }, { id: item.enabled ? 'disable' : 'enable', label: item.enabled ? c.disable : c.enable }, { id: 'remove', label: c.remove, danger: true }] : [])]
  }
  return [
    { id: 'edit', label: c.edit },
    { id: 'copy', label: c.copy },
    ...(kind === 'skills' ? [{ id: 'resources', label: c.resources }, { id: 'update', label: c.updatePackage }] : []),
    { id: item.enabled ? 'disable' : 'enable', label: item.enabled ? c.disable : c.enable, separated: true },
    { id: 'remove', label: c.remove, danger: true, separated: true },
  ]
}
function showEditor(kind: Editable, mode: 'create' | 'edit' | 'copy', id = ''): void {
  if (cap.saving || !cap.catalog) return
  const item = currentItem(kind, id)
  if ((mode !== 'create' && !item) || (mode === 'edit' && item?.pluginId && cap.catalog.plugins.find(plugin => plugin.id === item.pluginId)?.source !== 'vault')) return
  cap.error = ''
  editor.value = { kind, mode, item: item ?? null }
}
async function action(id: string, rowId: string): Promise<void> {
  if (cap.saving) return
  if (id === 'copy-id') {
    void navigator.clipboard.writeText(rowId).then(() => toasts.info(c.copiedId)).catch((e: Error) => toasts.error(e.message))
    return
  }
  if (id === 'resources') { manager.value = { mode: 'resources', id: rowId, owner: cap.page === 'plugins' ? 'plugin' : 'skill' }; return }
  if (id === 'update') { void previewUpdate(cap.page === 'plugins' ? 'plugin' : 'skill', rowId); return }
  if (id === 'toggle-tool') { const tool = cap.catalog?.tools.find(tool => tool.id === rowId); if (tool) void cap.setToolEnabled(tool.id, !tool.enabled); return }
  if (cap.page === 'runs') {
    if (id === 'open-conversation') { const run = cap.runs.find(r => r.id === rowId); if (run) { cap.openConversation(run.conversationId); emit('use') } }
    else if (id === 'remove-run') removingRun.value = rowId
    else { const agentId = cap.runs.find(r => r.id === rowId)?.message.context?.agentId; if (agentId) openDetail('agents', agentId) }
    return
  }
  if (cap.page === 'plugins') {
    const plugin = cap.catalog?.plugins.find(plugin => plugin.id === rowId)
    if (id === 'plugin-copy') manager.value = { mode: 'copy', id: rowId }
    else if (id === 'plugin-edit') manager.value = { mode: 'plugin', id: rowId }
    else if (id === 'uninstall') { try { removal.value = { kind: 'plugin', id: rowId, affected: await call('capabilities:impact', { owner: 'plugin', id: rowId }) } } catch (e) { toasts.error((e as Error).message) } }
    else if (plugin) void togglePlugin(plugin)
    return
  }
  if (cap.page !== 'agents' && cap.page !== 'skills') return
  const kind = cap.page
  const item = currentItem(kind, rowId)
  if (!item) return
  if (id === 'view-plugin' && item.pluginId) { openDetail('plugins', item.pluginId); return }
  if (id === 'copy' || id === 'edit') { showEditor(kind, id, rowId); return }
  if (id === 'enable') { void setEnabled(item, true); return }
  if (id !== 'remove' && id !== 'disable') return
  cap.error = ''
  confirmation.value = {
    kind, item, action: id, label: c[id],
    affected: kind === 'skills' ? await call('capabilities:impact', { owner: 'skill', id: rowId }).catch((e: Error) => { toasts.error(e.message); return [] }) : [],
  }
}
function setEnabled(item: PreviewAgent | PreviewSkill, enabled: boolean): Promise<boolean> {
  return 'instructions' in item ? cap.setAgentEnabled(item.id, enabled) : cap.changeSkill({ action: 'enable', id: item.id, enabled })
}
async function confirm(): Promise<void> {
  const change = confirmation.value
  if (!change || cap.saving) return
  const { action, item } = change
  const ok = action === 'disable' ? await setEnabled(item, false)
    : change.kind === 'agents' ? await cap.changeAgent(action, item.id)
    : await cap.changeSkill({ action, id: item.id })
  if (ok) confirmation.value = null
}
async function removeRun(): Promise<void> {
  if (removing.value) return
  removing.value = true
  try { await call('capabilities:removeRun', { runId: removingRun.value }); await cap.loadRuns(); removingRun.value = '' }
  catch (e) { toasts.error((e as Error).message) }
  finally { removing.value = false }
}
function showSaved(id: string, message: string = c.saved): void {
  queries[cap.page] = ''
  filters[cap.page] = ''
  cap.selected = id
  detailOpen.value = true
  toasts.info(message)
}
async function savedAgent(item: AgentConfiguration): Promise<void> {
  if (await cap.saveAgent(item)) {
    editor.value = null
    showSaved(item.id)
  }
}
async function savedSkill(change: Extract<SkillChange, { action: 'save' }>): Promise<void> {
  if (await cap.changeSkill(change)) {
    editor.value = null
    showSaved(change.id ?? change.content.name)
  }
}
async function togglePlugin(plugin: ManagedPlugin): Promise<void> {
  cap.error = ''
  if (plugin.enabled) { pluginConfirmation.value = plugin; return }
  await cap.setPluginEnabled(plugin.id, true)
}
async function previewUpdate(owner: 'plugin' | 'skill', id: string) {
  cap.error = ''
  importingBusy.value = true
  try {
    const preview = await call('capabilities:previewUpdate', { owner, id })
    if (owner === 'plugin') importingPlugin.value = preview as PluginImportPreview | null
    else { importing.value = preview as SkillImportPreview | null; importingName.value = id }
  } catch (e) { toasts.error((e as Error).message) }
  finally { importingBusy.value = false }
}
async function uninstallPlugin() {
  if (removal.value && await cap.changePlugin({ action: 'remove', id: removal.value.id })) removal.value = null
}
async function previewPluginImport(): Promise<void> {
  if (importingBusy.value) return
  importingBusy.value = true
  try { cap.error = ''; importingPlugin.value = await call('capabilities:previewPluginImport') }
  catch (error) { toasts.error((error as Error).message) }
  finally { importingBusy.value = false }
}
function cancelPluginImport(): void {
  if (!importingPlugin.value || importingBusy.value) return
  const token = importingPlugin.value.token
  importingPlugin.value = null
  void call('capabilities:cancelPluginImport', { token }).catch(() => {})
}
async function confirmPluginImport(): Promise<void> {
  if (!importingPlugin.value || importingBusy.value) return
  const preview = importingPlugin.value
  importingBusy.value = true
  try {
    if (await cap.importPlugin(preview.token)) {
      importingPlugin.value = null
      showSaved(preview.id, c.pluginInstalled)
    }
  } finally { importingBusy.value = false }
}
async function disablePlugin(): Promise<void> {
  if (pluginConfirmation.value && await cap.setPluginEnabled(pluginConfirmation.value.id, false)) pluginConfirmation.value = null
}
async function previewImport(): Promise<void> {
  if (importingBusy.value) return
  importingBusy.value = true
  try {
    cap.error = ''
    importing.value = await call('capabilities:previewSkillImport')
    importingName.value = importing.value?.suggestedName ?? ''
  } catch (e) { toasts.error((e as Error).message) }
  finally { importingBusy.value = false }
}
function cancelImport(): void {
  if (!importing.value || importingBusy.value) return
  const { token } = importing.value
  importing.value = null
  void call('capabilities:cancelSkillImport', { token }).catch(() => {})
}
async function confirmImport(): Promise<void> {
  if (!importing.value || importingBusy.value || !importNameValid.value) return
  const name = importingName.value.trim()
  importingBusy.value = true
  try {
    if (await cap.importSkill(importing.value.token, name)) {
      importing.value = null
      showSaved(name, c.skillImported)
    }
  } finally { importingBusy.value = false }
}
function choose(id: string, enter = true): void { cap.selected = id; if (enter) detailOpen.value = true }
function openDetail(page: CapabilityPage, id: string): void { cap.open(page, id); detailOpen.value = true }
async function back(): Promise<void> {
  detailOpen.value = false
  await nextTick()
  list.value?.focus(cap.selected)
}
watch([() => queries.runs, () => filters.runs], () => { runPage.value = 1 })
watch([() => queries[cap.page], () => filters[cap.page]], () => { detailOpen.value = false }, { flush: 'sync' })
watch([() => queries.runs, () => filters.runs, runPage, () => cap.page], () => {
  if (cap.page === 'runs') void cap.loadRuns({ text: queries.runs, status: filters.runs as RunRecord['status'] || undefined, offset: (runPage.value - 1) * 30, limit: 30 }).catch((e: Error) => { cap.error = e.message })
})
watch([rows, () => cap.selected], ([items]) => {
  if (!items.some((row) => row.id === cap.selected)) cap.selected = items[0]?.id ?? ''
}, { immediate: true })
watch(() => cap.requestedDetail, () => {
  if (cap.detailRequested) { queries[cap.page] = ''; filters[cap.page] = '' }
  detailOpen.value = cap.detailRequested
}, { flush: 'sync' })
watch(() => active, (value) => { if (value) void cap.load(true) }, { immediate: true })
</script>

<template>
  <div class="capabilities" :class="{ 'detail-open': detailOpen }" data-testid="capabilities">
    <header class="page-head">
      <div>
        <div class="cap-breadcrumb"><span>{{ c.title }}</span><span>/</span><span>{{ c.tabs[cap.page] }}</span></div>
        <h1>{{ c.tabs[cap.page] }}</h1>
        <p>{{ c.pageDescriptions[cap.page] }}</p>
      </div>
      <div class="cap-head-actions">
        <button v-if="cap.page === 'skills'" :disabled="cap.saving || cap.loading || !cap.catalog" data-testid="cap-task-bindings" @click="manager = { mode: 'tasks' }">{{ c.taskBindings }}</button>
        <button v-if="cap.page === 'plugins'" class="primary" :disabled="cap.saving || cap.loading || !cap.catalog" data-testid="cap-create-plugin" @click="manager = { mode: 'plugin' }"><Plus :size="15" />{{ c.newPlugin }}</button>
        <button v-if="cap.page === 'plugins'" :disabled="cap.saving || cap.loading || !cap.catalog || importingBusy" data-testid="cap-import-plugin" @click="previewPluginImport"><FolderOpen :size="15" />{{ c.importPlugin }}</button>
        <button v-if="cap.page === 'skills'" :disabled="cap.saving || cap.loading || !cap.catalog || importingBusy" data-testid="cap-import" @click="previewImport">
          <FolderOpen :size="15" />{{ c.importSkill }}
        </button>
        <button v-if="canCreate" class="primary create" :disabled="cap.saving || cap.loading || !cap.catalog || importingBusy" data-testid="cap-create" @click="showEditor(cap.page as Editable, 'create')">
          <Plus :size="15" />{{ cap.page === 'agents' ? c.newAgent : c.newSkill }}
        </button>
      </div>
    </header>
    <div v-if="cap.loading && !cap.catalog" class="cap-empty" role="status">{{ c.loading }}</div>
    <div v-else-if="cap.error && !cap.catalog" class="cap-empty"><p class="bad" role="alert">{{ cap.error }}</p><button data-testid="cap-retry" @click="cap.load()">{{ c.retry }}</button></div>
    <template v-else-if="cap.catalog">
      <div v-if="cap.error" class="cap-catalog-error" role="alert"><span>{{ cap.error }}</span><button @click="cap.load(true)">{{ c.retry }}</button></div>
      <details v-if="cap.catalog.issues.length" class="cap-diagnostics" data-testid="cap-diagnostics"><summary>{{ c.diagnostics(cap.catalog.issues.length) }}</summary><p v-for="issue in cap.catalog.issues" :key="issue">{{ issue }}</p></details>
      <div class="filterbar"><label class="searchbox"><Search :size="15" /><input ref="search" v-model="queries[cap.page]" type="search" maxlength="200" :aria-label="c.searchHints[cap.page]" :placeholder="c.searchHints[cap.page]" data-testid="cap-search" @keydown.esc.prevent="queries[cap.page] = ''" /><kbd>/</kbd></label><div class="cap-filters" :aria-label="c.filterLabel" :data-testid="cap.page === 'runs' ? 'cap-run-status' : 'cap-status'"><button v-for="option in filterOptions" :key="option.value" class="ghost" :aria-pressed="filters[cap.page] === option.value" :data-testid="'cap-filter-' + (option.value || 'all')" @click="filters[cap.page] = option.value">{{ option.label }}</button></div><span class="cap-result-count" data-testid="cap-result-count">{{ c.resultCount(cap.page, cap.page === 'runs' ? cap.runTotal : rows.length) }}</span><button class="ghost icon-button refresh" :disabled="cap.loading" :aria-label="c.refresh" :title="c.refresh" data-testid="cap-refresh" @click="cap.load(true)"><RefreshCw :size="14" /></button></div>
      <div class="workspace">
        <div class="list-side"><CapabilityList ref="list" :page="cap.page" :rows :selected="cap.selected" :menus :narrowed @choose="choose" @action="action" @clear="clearFilters"><template #pager><Pager v-if="cap.page === 'runs' && cap.runTotal > 30" :page="runPage" :total="cap.runTotal" :size="30" prefix="cap-runs" @change="runPage = $event" /></template></CapabilityList></div>
        <div class="detail-side" data-testid="cap-detail-side"><button class="ghost detail-back" data-testid="cap-back" @click="back"><ArrowLeft :size="15" />{{ c.back }}</button>
          <ExecutionDetails v-if="cap.page === 'runs' && selectedRun" :key="selectedRun.id" :run="selectedRun"><template #actions><ObjectMenu :actions="menus(cap.selected)" :label="c.moreDetails" trigger-id="cap-detail-more" @select="action($event, cap.selected)" /></template></ExecutionDetails>
          <PluginDetails v-else-if="cap.page === 'plugins' && cap.catalog.plugins.find(plugin => plugin.id === cap.selected)" :plugin="cap.catalog.plugins.find(plugin => plugin.id === cap.selected)!" @open="openDetail" @toggle="togglePlugin(cap.catalog.plugins.find(plugin => plugin.id === cap.selected)!)"><template #actions><ObjectMenu :actions="menus(cap.selected)" :label="c.moreDetails" trigger-id="cap-detail-more" @select="action($event, cap.selected)" /></template></PluginDetails>
          <CapabilityDetails v-else-if="cap.page !== 'runs' && cap.page !== 'plugins' && cap.selected" :id="cap.selected" :key="cap.page + cap.selected" :kind="cap.page" @open="openDetail"><template #actions><button v-if="cap.page === 'tools'" data-testid="cap-copy-id" @click="action('copy-id', cap.selected)">{{ c.copyId }}</button><button v-else-if="currentItem(cap.page as Editable, cap.selected)?.pluginId && cap.catalog.plugins.find(plugin => plugin.id === currentItem(cap.page as Editable, cap.selected)?.pluginId)?.source === 'bundled'" data-testid="cap-copy" @click="action('copy', cap.selected)"><Copy :size="14" />{{ c.copy }}</button><button v-else data-testid="cap-edit" @click="action('edit', cap.selected)"><Pencil :size="14" />{{ c.edit }}</button><ObjectMenu :actions="menus(cap.selected)" :label="c.moreDetails" trigger-id="cap-detail-more" @select="action($event, cap.selected)" /></template></CapabilityDetails>
          <div v-else class="cap-empty">{{ c.noSelection }}</div>
        </div>
      </div>
    </template>
    <AppDialog v-if="removingRun" :title="c.removeRunTitle" :busy="removing" @close="removingRun = ''"><p>{{ c.removeRunHint }}</p><template #footer><div class="dialog-actions"><button :disabled="removing" @click="removingRun = ''">{{ c.cancel }}</button><button class="primary" :disabled="removing" data-testid="cap-remove-run-confirm" @click="removeRun">{{ c.removeRunConfirm }}</button></div></template></AppDialog>
    <AppDialog v-if="pluginConfirmation" :title="c.confirmChange(c.disable, pluginConfirmation.name)" :busy="cap.saving" @close="pluginConfirmation = null">
      <p>{{ c.pluginDisableHint }}</p><p v-if="cap.error" class="dialog-error" role="alert">{{ cap.error }}</p>
      <template #footer><div class="dialog-actions"><button :disabled="cap.saving" @click="pluginConfirmation = null">{{ c.cancel }}</button><button class="primary" :disabled="cap.saving" data-testid="cap-plugin-confirm" @click="disablePlugin">{{ c.confirm }}</button></div></template>
    </AppDialog>
    <AppDialog v-if="importingPlugin" :title="importingPlugin.name" :busy="importingBusy" scroll-body @close="cancelPluginImport">
      <p>{{ importingPlugin.description }}</p><p v-if="importingPlugin.removedFiles?.length">{{ c.removedFiles }}：{{ importingPlugin.removedFiles.join('、') }}</p><p class="small muted">{{ c.pluginEnableHint }}</p>
      <ul v-if="importingPlugin.issues.length" class="cap-import-warnings"><li v-for="issue in importingPlugin.issues" :key="issue">{{ issue }}</li></ul>
      <details open class="cap-import-files"><summary>{{ c.importFiles(importingPlugin.files.length) }}</summary><ul><li v-for="file in importingPlugin.files" :key="file"><code>{{ file }}</code></li></ul></details>
      <p v-if="cap.error" class="dialog-error" role="alert">{{ cap.error }}</p>
      <template #footer><div class="dialog-actions"><button :disabled="importingBusy" @click="cancelPluginImport">{{ c.cancel }}</button><button class="primary" :disabled="importingBusy" data-testid="cap-plugin-import-confirm" @click="confirmPluginImport">{{ c.importPlugin }}</button></div></template>
    </AppDialog>
    <CapabilityManagerDialog v-if="manager" v-bind="manager" @close="manager = null" @saved="showSaved" />
    <AppDialog v-if="removal" :title="c.uninstall" :busy="cap.saving" @close="removal = null"><p>{{ c.capabilityRemoveHint }}</p><p>{{ removal.affected.join('、') || c.noImpact }}</p><p v-if="cap.error" role="alert">{{ cap.error }}</p><template #footer><div class="dialog-actions"><button :disabled="cap.saving" @click="removal = null">{{ c.cancel }}</button><button class="primary" :disabled="cap.saving" data-testid="cap-uninstall-confirm" @click="uninstallPlugin">{{ c.confirm }}</button></div></template></AppDialog>
    <CapabilityEditor v-if="editor" :kind="editor.kind" :item="editor.item" :mode="editor.mode" @close="editor = null" @save-agent="savedAgent" @save-skill="savedSkill" />
    <AppDialog v-if="importing" :title="importing.title" :busy="importingBusy" class="cap-import-dialog" scroll-body @close="cancelImport">
      <form id="cap-import-form" @submit.prevent="confirmImport">
        <p>{{ importing.description }}</p>
        <label class="dialog-field">
          {{ c.skillIdentifier }}
          <input v-model="importingName" class="dialog-input" data-testid="cap-import-name" maxlength="64" :placeholder="importing.name" autofocus :disabled="importingBusy" :readonly="!!importing.updating" @input="cap.error = ''" />
        </label>
        <p v-if="importing.updating" class="small">{{ c.updatePackage }}：{{ importing.updating }}</p><p v-if="importing.removedFiles?.length" class="small">{{ c.removedFiles }}：{{ importing.removedFiles.join('、') }}</p><p v-if="importing.conflict" class="small muted" data-testid="cap-import-conflict">{{ c.importConflict(importing.name) }}</p>
        <p v-if="importingName.trim() && !importNameValid" class="dialog-error">{{ c.identifierInvalid }}</p>
        <p v-if="importing.requiredTools?.length" class="small muted">{{ c.importTools(importing.requiredTools.join('、')) }}</p>
        <ul v-if="importing.warnings.length" class="cap-import-warnings" data-testid="cap-import-warnings"><li v-for="warning in importing.warnings" :key="warning">{{ warning }}</li></ul>
        <details open class="cap-import-files" data-testid="cap-import-files">
          <summary>{{ c.importFiles(importing.files.length) }}</summary>
          <ul><li v-for="file in importing.files" :key="file"><code>{{ file }}</code></li></ul>
        </details>
        <p v-if="cap.error" class="dialog-error" role="alert">{{ cap.error }}</p>
      </form>
      <template #footer>
        <div class="dialog-actions">
          <button :disabled="importingBusy" @click="cancelImport">{{ c.cancel }}</button>
          <button type="submit" form="cap-import-form" class="primary" :disabled="importingBusy || !importNameValid" data-testid="cap-import-confirm">{{ c.importSkill }}</button>
        </div>
      </template>
    </AppDialog>
    <AppDialog v-if="confirmation" :title="c.confirmChange(confirmation.label, 'instructions' in confirmation.item ? confirmation.item.name : confirmation.item.title)" :busy="cap.saving" @close="confirmation = null"><p>{{ confirmation.kind === 'skills' && confirmation.action === 'remove' ? c.removeSkillHint : c.changeHint }}</p><p v-if="confirmation.kind === 'skills'" class="small muted">{{ c.impact }}：{{ confirmation.affected.join('、') || c.noImpact }}<br />{{ c.dependencyHint }}</p><p v-if="cap.error" class="dialog-error" role="alert">{{ cap.error }}</p><template #footer><div class="dialog-actions"><button :disabled="cap.saving" @click="confirmation = null">{{ c.cancel }}</button><button class="primary" data-testid="cap-confirm" :disabled="cap.saving" @click="confirm">{{ c.confirm }}</button></div></template></AppDialog>
  </div>
</template>
