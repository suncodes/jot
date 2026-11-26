<script setup lang="ts">
import { isReservedShortcut, shortcutFromEvent } from '@shared/shortcut-keys'
import { mappedPath } from '@shared/files'
import { isAbsoluteFilePath } from '@shared/file-links'
import { Bot, Activity, CalendarDays, FilePlus2, Layers, Moon, MoreHorizontal, PanelLeft, PanelRight, Search, Settings as SettingsIcon, Sun, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { call, invoke, on } from '@/api'
import AppDialog from './AppDialog.vue'
import ContentDirectorySelect from './ContentDirectorySelect.vue'
import CaptureInput from '@/components/CaptureInput.vue'
import JobsPopover from '@/components/JobsPopover.vue'
import CapabilitiesSidebar from '@/components/CapabilitiesSidebar.vue'
import LibrarySidebar from '@/components/LibrarySidebar.vue'
import QuickOpen from '@/components/QuickOpen.vue'
import Toasts from '@/components/Toasts.vue'
import TimelineSidebar from '@/components/TimelineSidebar.vue'
import AgentPanel from '@/views/AgentPanel.vue'
import CapabilitiesView from '@/views/CapabilitiesView.vue'
import ArchiveView from '@/views/ArchiveView.vue'
import ContentView from '@/views/ContentView.vue'
import FilesPanel from '@/views/FilesPanel.vue'
import InboxPanel from '@/views/InboxPanel.vue'
import LibraryView from '@/views/LibraryView.vue'
import SearchWorkspace from '@/components/SearchWorkspace.vue'
import SettingsView from '@/views/SettingsView.vue'
import SettingsSidebar from '@/components/settings/SettingsSidebar.vue'
import QuickRail from '@/components/commands/QuickRail.vue'
import CommandPalette from '@/components/commands/CommandPalette.vue'
import { useCommandsStore } from '@/stores/commands'
import { useExtensionsStore } from '@/stores/extensions'
import TaxonomyView from '@/views/TaxonomyView.vue'
import TodayView from '@/views/TodayView.vue'
import TrashView from '@/views/TrashView.vue'
import { useAppStore } from '@/stores/app'
import { useLibraryStore } from '@/stores/library'
import { useLibraryPinsStore } from '@/stores/pins'
import { ARCHIVE_TAB, CAPABILITIES_TAB, LIBRARY_TAB, REVIEW_TAB, TAXONOMY_TAB, TODAY_TAB, TRASH_TAB, useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { selectedText } from '@/utils/textActions'
import { t } from '@/strings'

const app = useAppStore()
const commands = useCommandsStore()
const extensions = useExtensionsStore()
const tabs = useTabsStore()
const library = useLibraryStore()
const toasts = useToastsStore()
const layout = computed(() => app.settings!.layout)
const agentWasOpened = ref(!layout.value.agentCollapsed)
const settingsWasOpened = ref(app.showSettings)
watch(() => app.showSettings, opened => { if (opened) settingsWasOpened.value = true })
watch(() => layout.value.agentCollapsed, (collapsed) => { if (!collapsed) agentWasOpened.value = true })
const agentsModule = computed(() => tabs.activePath === CAPABILITIES_TAB)
const timeline = computed(() => tabs.activePath === TODAY_TAB)
const now = new Date()
const timelineDate = ref([now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-'))
const modelText = computed(() => ({ ok: t.status.modelOk, 'not-configured': t.status.modelNotConfigured, unavailable: t.status.modelUnavailable })[app.modelState])
const showQuickOpen = ref(false)
const toolsOpen = ref(false)
const utility = ref<'files' | 'search' | null>(null)
const viewport = ref(window.innerWidth)
const showSide = computed(() => app.showSettings || !layout.value.sideCollapsed && (utility.value === 'search' || layout.value.agentCollapsed || viewport.value >= 1180))
const activeJobs = computed(() => app.jobs.running + app.jobs.queued - app.jobs.waitingModel)
const searchPanel = ref<InstanceType<typeof SearchWorkspace> | null>(null)
const capture = ref<InstanceType<typeof CaptureInput> | null>(null)
const agentPanel = ref<InstanceType<typeof AgentPanel> | null>(null)
const importOpen = ref(false)
const importTarget = ref('pending')
const importPending = ref<File[] | null>(null)
const picker = ref<HTMLInputElement | null>(null)
const dragFrom = ref<number | null>(null)
const dropping = ref(false)
const offs: (() => void)[] = []
let dragDepth = 0
watch(() => app.vault.path, () => { extensions.reset(); void extensions.refresh() }, { immediate: true })

function openTimeline(): void { utility.value = null; void tabs.open(TODAY_TAB, { newTab: true, title: t.library.timeline }) }
function onCaptureSaved(path: string): void {
  toasts.info(t.library.ideaSaved, { label: t.library.openIdea, run: () => tabs.open(path, { newTab: true }) })
}
function openLibrary(): void { utility.value = null; void tabs.open(LIBRARY_TAB, { newTab: true, title: t.library.title }) }
async function showUtility(view: 'files' | 'search', keepAgent = false): Promise<void> {
  toolsOpen.value = false
  utility.value = view
  app.showSettings = false
  await app.updateSettings({ layout: { sideCollapsed: false, ...(viewport.value < 1180 && !keepAgent ? { agentCollapsed: true } : {}) } })
  await nextTick()
}
async function openSearch(scope: 'all' | 'current' = 'all', element?: HTMLElement): Promise<void> {
  const selection = element ? selectedText(element).slice(0, 200) : undefined
  await showUtility('search', !!element?.closest('[data-testid="agent"]'))
  searchPanel.value?.open(scope, element, selection)
}
function onFindRequest(e: Event): void {
  void openSearch('current', (e as CustomEvent<HTMLElement>).detail)
}
function onFindKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || app.showSettings || showQuickOpen.value || document.querySelector('dialog[open]')) return
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'f') return
  e.preventDefault()
  e.stopPropagation()
  const focused = document.activeElement as HTMLElement | null
  const element = focused?.closest<HTMLElement>('[data-find-scope]')?.querySelector<HTMLElement>('[data-find-target]') ?? undefined
  void openSearch(e.shiftKey ? 'all' : 'current', element)
}
function openReview(): void {
  toolsOpen.value = false
  utility.value = null
  app.showJobs = false
  void tabs.open(REVIEW_TAB, { newTab: true, title: t.inbox.title })
}
function openCapabilities(): void {
  toolsOpen.value = false
  utility.value = null
  app.showJobs = false
  void tabs.open(CAPABILITIES_TAB, { newTab: true, title: t.capabilities.title })
}
function openArchive(): void {
  toolsOpen.value = false
  utility.value = null
  app.showJobs = false
  void tabs.open(ARCHIVE_TAB, { newTab: true, title: t.archive.title })
}
async function targetDirectory(): Promise<string | undefined> {
  if (tabs.activePath === LIBRARY_TAB) {
    if (library.unavailable) throw new Error(t.directory.unavailable)
    return library.scope.directoryPath
  }
  const current = tabs.active
  if (current?.path.startsWith('content/')) {
    const parent = current.path.split('/').slice(0, -1).join('/')
    return parent === 'content' ? undefined : parent
  }
  return undefined
}
async function newNote(): Promise<void> {
  try {
    const id = await targetDirectory()
    const meta = await call('doc:create', { dir: id, title: t.files.newNoteTitle })
    await tabs.open(meta.path, { newTab: true, title: meta.title, startEditing: true })
  } catch (e) { toasts.error((e as Error).message) }
}
async function openImport(files: File[] | null = null): Promise<void> {
  try { importTarget.value = await targetDirectory() ?? 'pending'; importPending.value = files; importOpen.value = true }
  catch (e) { toasts.error((e as Error).message) }
}
async function confirmImport(): Promise<void> {
  importOpen.value = false
  if (importPending.value) { await importFiles(importPending.value, importTarget.value); importPending.value = null }
  else picker.value?.click()
}
async function importFiles(files: File[], directoryPath = importTarget.value): Promise<void> {
  dragDepth = 0; dropping.value = false
  const paths = files.map(f => window.jot.pathForFile(f)).filter(Boolean)
  if (!paths.length) { if (files.length) toasts.error(t.archive.noPath); return }
  const result = await invoke('files:import', { paths, toDir: directoryPath === 'pending' ? undefined : directoryPath === 'root' ? 'content' : directoryPath })
  if (!result.ok) { toasts.error(result.error.message); return }
  if (result.data.imported.length) toasts.info(t.archive.imported(result.data.imported.length))
  for (const skip of result.data.skipped) toasts.error(t.archive.skipped(skip.path.split(/[\\/]/).pop()!, skip.reason))
  utility.value = null
  library.select(directoryPath === 'pending' ? { collection: 'pending' } : directoryPath === 'root' ? { collection: 'all' } : { directoryPath })
  library.filters.kind = 'file'
}
async function onPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  await importFiles([...(input.files ?? [])])
  input.value = ''
}
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files')
function onDragEnter(e: DragEvent): void { if (hasFiles(e)) { dragDepth++; dropping.value = true } }
function onDragLeave(e: DragEvent): void { if (hasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); dropping.value = !!dragDepth } }
async function onDrop(e: DragEvent): Promise<void> {
  if (!hasFiles(e)) return
  e.preventDefault(); dragDepth = 0; dropping.value = false
  await openImport([...(e.dataTransfer?.files ?? [])])
}
function toggleAgent(): void { void app.updateSettings({ layout: { agentCollapsed: !layout.value.agentCollapsed } }) }
function toggleTheme(): void { void app.updateSettings({ appearance: { theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' } }) }
async function openAssistantHistory(): Promise<void> {
  await focusAgent()
  agentPanel.value?.history()
}
async function focusAgent(): Promise<void> {
  app.showSettings = false
  if (layout.value.agentCollapsed) await app.updateSettings({ layout: { agentCollapsed: false } })
  await nextTick(); agentPanel.value?.focus()
}
function startResize(which: 'side' | 'agent', e: MouseEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const key = which === 'side' ? 'sideWidth' : 'agentWidth'
  const start = layout.value[key]
  const [min, max] = which === 'side' ? [200, 360] : [348, 560]
  const move = (ev: MouseEvent) => { app.settings!.layout[key] = Math.min(max, Math.max(min, start + (which === 'side' ? ev.clientX - startX : startX - ev.clientX))) }
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    void app.updateSettings({ layout: { [key]: app.settings!.layout[key] } })
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}
function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat || e.getModifierState('AltGraph') || document.querySelector('dialog[open]')) return
  if (showQuickOpen.value || document.querySelector('[role="menu"]')) return
  const editing = e.target instanceof HTMLElement && !!e.target.closest('input, textarea, [contenteditable="true"]')
  const shortcut = shortcutFromEvent(e, editing)
  if (shortcut === 'Ctrl+Shift+P' || shortcut === 'Meta+Shift+P') {
    e.preventDefault(); e.stopPropagation(); toolsOpen.value = false
    void commands.execute('core.command-palette')
    return
  }
  if (shortcut && !isReservedShortcut(shortcut)) {
    const equivalent = (value: string) => value.replace('Meta+', 'Ctrl+')
    const binding = extensions.shortcuts.bindings.find(binding => equivalent(binding.hotkey) === equivalent(shortcut))
    if (binding && extensions.availableCommands.some(command => command.id === binding.commandId)) {
      e.preventDefault(); e.stopPropagation(); toolsOpen.value = false
      void commands.execute(binding.commandId)
      return
    }
  }
  if (e.key === 'Escape') toolsOpen.value = false
  if (!e.ctrlKey || e.altKey) return
  const key = e.key.toLowerCase()
  const run = (fn: () => unknown) => { e.preventDefault(); void fn() }
  if (e.shiftKey) {
    if (key === 'f') run(() => openSearch('all'))
    else if (key === 'tab') run(() => tabs.cycle(-1))
    return
  }
  if (key === 'n') run(newNote)
  else if (key === 'o') run(() => (showQuickOpen.value = true))
  else if (key === 'j') run(() => { app.showSettings = false; void nextTick(() => capture.value?.focus()) })
  else if (key === 'l') run(focusAgent)
  else if (key === 'w') run(() => tabs.activePath && tabs.close(tabs.activePath))
  else if (key === 'tab') run(() => tabs.cycle(1))
  else if (key === ',') run(() => (app.showSettings = true))
}
const onResize = () => { viewport.value = window.innerWidth }
onMounted(() => {
  offs.push(extensions.connect(), useLibraryPinsStore().connect())
  if (!tabs.tabs.length) openTimeline()
  window.addEventListener('keydown', onKey); window.addEventListener('resize', onResize)
  window.addEventListener('jot:find', onFindRequest)
  window.addEventListener('keydown', onFindKey, true)
  offs.push(on('hotkey:conflict', ({ hotkey }) => toasts.error(t.hotkey.conflict(hotkey), { label: t.hotkey.goSettings, run: () => { app.settingsSection = 'capture'; app.showSettings = true } })),
    on('storage:changed', change => {
      if (!change.moves) return
      const libraryMoves = change.moves.filter(move => !isAbsoluteFilePath(move.from) && !isAbsoluteFilePath(move.to))
      for (const tab of [...tabs.tabs]) tabs.retarget(tab.path, mappedPath(tab.path, libraryMoves))
      library.applyMoves(libraryMoves)
    }))

})
onUnmounted(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); window.removeEventListener('jot:find', onFindRequest); window.removeEventListener('keydown', onFindKey, true); offs.forEach((off) => off()) })
</script>

<template>
  <div class="shell" data-testid="shell" @dragenter="onDragEnter" @dragleave="onDragLeave" @dragover.prevent @drop="onDrop">
    <AppDialog v-if="importOpen" :title="t.directory.importTitle" @close="importOpen = false">
      <form @submit.prevent="confirmImport"><p class="small muted">{{ t.directory.importHint }}</p><label>{{ t.directory.position }}<ContentDirectorySelect v-model="importTarget" allow-pending data-testid="import-target" /></label><div class="dialog-actions"><button type="button" @click="importOpen = false">{{ t.common.cancel }}</button><button class="primary" data-testid="import-choose">{{ t.actions.confirm }}</button></div></form>
    </AppDialog>
    <header class="topbar">
      <div class="brand"><span>J</span><strong>{{ t.appName }}</strong></div>
      <nav class="primary-nav" data-testid="ribbon" :aria-label="t.library.title">
        <button class="ghost" :aria-current="timeline && !app.showSettings ? 'page' : undefined" data-testid="ribbon-today" @click="openTimeline"><CalendarDays :size="15" />{{ t.library.timeline }}</button>
        <button class="ghost" :aria-current="!timeline && !agentsModule && !app.showSettings ? 'page' : undefined" data-testid="ribbon-library" @click="openLibrary"><Layers :size="15" />{{ t.library.title }}</button>
        <button class="ghost" :aria-current="agentsModule && !app.showSettings ? 'page' : undefined" data-testid="ribbon-capabilities" @click="openCapabilities"><Bot :size="16" />{{ t.capabilities.title }}</button>
      </nav>
      <div class="actions">
        <button class="primary new-note" data-testid="new-note" :title="t.files.newNote + ' (Ctrl+N)'" @click="newNote"><FilePlus2 :size="15" /><span>{{ t.files.newNote }}</span></button>
        <button class="tasks-button" data-testid="jobs-open" :aria-expanded="app.showJobs" :title="t.jobs.title" @click="app.showJobs = !app.showJobs"><Activity :size="15" /><span>{{ t.jobs.entry }}</span><span v-if="activeJobs || app.jobs.waitingModel" class="task-count">{{ activeJobs + app.jobs.waitingModel }}</span><span v-if="app.jobs.failed" class="task-alert" :aria-label="t.jobs.failed(app.jobs.failed)" :title="t.jobs.failed(app.jobs.failed)" /></button>
        <button class="icon-button" data-testid="ribbon-search" :title="t.ribbon.search + ' (Ctrl+Shift+F)'" @click="openSearch('all')"><Search :size="16" /></button>
        <button class="icon-button theme-toggle" data-testid="theme-toggle" :title="t.library.theme" @click="toggleTheme"><Moon v-if="app.settings?.appearance.theme !== 'dark'" :size="16" /><Sun v-else :size="16" /></button>
        <button class="icon-button" data-testid="agent-open" :title="t.agent.title + ' (Ctrl+L)'" :aria-expanded="!layout.agentCollapsed" @click="toggleAgent"><PanelRight :size="16" /></button>
        <button class="icon-button" data-testid="ribbon-settings" :title="t.ribbon.settings" @click="app.showSettings = !app.showSettings"><SettingsIcon :size="16" /></button>
        <div class="tools">
          <button class="ghost icon-button" :title="t.library.tools" :aria-expanded="toolsOpen" data-testid="tools-open" @click="toolsOpen = !toolsOpen"><MoreHorizontal :size="18" /></button>
          <div v-if="toolsOpen" class="tools-menu" @keydown.esc="toolsOpen = false">
            <button class="ghost" data-testid="ribbon-command-palette" @click="toolsOpen = false; commands.execute('core.command-palette')">{{ t.commandPalette.title }}<kbd>Ctrl+Shift+P</kbd></button>
            <button class="ghost" data-testid="ribbon-shortcuts" @click="toolsOpen = false; commands.manage()">{{ t.shortcuts.title }}</button>
            <button class="ghost" data-testid="ribbon-files" @click="showUtility('files')">{{ t.library.storage }}</button>
            <button class="ghost" data-testid="ribbon-inbox" @click="openReview">{{ t.library.review }}</button>
            <button class="ghost" data-testid="ribbon-trash" @click="toolsOpen = false; tabs.open(TRASH_TAB, { newTab: true, title: '回收站' })">回收站</button>
            <button class="ghost" data-testid="ribbon-archive" @click="openArchive">{{ t.archive.title }}</button>
          </div>
        </div>
      </div>
    </header>
    <div class="body" data-search-observer><QuickRail />
      <aside v-show="showSide" class="side surface" :style="{ width: layout.sideWidth + 'px' }" data-testid="side-panel">
        <SettingsSidebar v-if="app.showSettings" /><div v-show="!app.showSettings" class="workspace-sidebar"><header v-if="utility === 'files'" class="panel-title"><span>{{ t.library.storage }}</span><button class="ghost icon-button" :title="t.common.close" @click="utility = null"><X :size="15" /></button></header>
        <SearchWorkspace v-show="utility === 'search'" ref="searchPanel" :active="showSide && utility === 'search' && !app.showSettings" @close="utility = null" />
        <FilesPanel v-if="utility === 'files'" /><template v-else-if="utility !== 'search'"><TimelineSidebar v-if="timeline" v-model="timelineDate" /><CapabilitiesSidebar v-else-if="agentsModule" /><LibrarySidebar v-else @import="importFiles" /></template>
        </div><div class="resizer right" data-testid="side-resizer" @mousedown="startResize('side', $event)" />
      </aside>
      <main class="content surface" data-testid="content">
        <div v-if="!app.showSettings" class="tabbar" data-testid="tabbar">
          <button class="ghost icon-button side-toggle" data-testid="side-toggle" :title="t.library.toggleSide" @click="app.updateSettings({ layout: { sideCollapsed: !layout.sideCollapsed } })"><PanelLeft :size="15" /></button>
          <div v-for="(tab, i) in tabs.tabs" :key="tab.key" class="tab" :class="{ active: tab.path === tabs.activePath }" data-testid="tab" :data-path="tab.path" draggable="true" @click="tabs.activePath = tab.path" @auxclick.middle="tabs.close(tab.path)" @dragstart="dragFrom = i" @dragover.prevent @drop="dragFrom !== null && tabs.move(dragFrom, i)">
            <button class="ghost tab-title" @click="tabs.activePath = tab.path">{{ tab.title }}</button><button class="ghost tab-close" :title="t.common.close" data-testid="tab-close" @click.stop="tabs.close(tab.path)"><X :size="12" /></button>
          </div>
        </div>
        <div class="stage">
          <SettingsView v-if="settingsWasOpened" v-show="app.showSettings" :key="app.vault.path" @history="openAssistantHistory" />
          <template v-for="tab in tabs.tabs" :key="tab.key">
            <LibraryView v-if="tab.path === LIBRARY_TAB" v-show="!app.showSettings && tab.path === tabs.activePath" :active="!app.showSettings && tab.path === tabs.activePath" @import="openImport()" @review="openReview" @capture="capture?.focus()" />
            <TodayView v-else-if="tab.path === TODAY_TAB" v-show="!app.showSettings && tab.path === tabs.activePath" v-model:date="timelineDate" />
            <InboxPanel v-else-if="tab.path === REVIEW_TAB" v-show="!app.showSettings && tab.path === tabs.activePath" :active="!app.showSettings && tab.path === tabs.activePath" />
            <ArchiveView v-else-if="tab.path === ARCHIVE_TAB" v-show="!app.showSettings && tab.path === tabs.activePath" />
            <TrashView v-else-if="tab.path === TRASH_TAB" v-show="!app.showSettings && tab.path === tabs.activePath" />
            <CapabilitiesView v-else-if="tab.path === CAPABILITIES_TAB" v-show="!app.showSettings && tab.path === tabs.activePath" :active="!app.showSettings && tab.path === tabs.activePath" @use="focusAgent" />
            <TaxonomyView v-else-if="tab.path === TAXONOMY_TAB" v-show="!app.showSettings && tab.path === tabs.activePath" />
            <ContentView v-else v-show="!app.showSettings && tab.path === tabs.activePath" :tab="tab" :active="!app.showSettings && tab.path === tabs.activePath" />
          </template><div v-if="!app.showSettings && !tabs.tabs.length" class="content-empty faint">{{ t.empty.tabs }}</div>
        </div>
        <div v-show="!app.showSettings && tabs.activePath !== CAPABILITIES_TAB" class="capture-bar" data-testid="capture-bar"><CaptureInput ref="capture" source="main-window" @saved="onCaptureSaved" /></div>
      </main>
      <aside v-if="agentWasOpened" v-show="!app.showSettings && !layout.agentCollapsed" class="agent surface" :style="{ width: Math.max(348, layout.agentWidth) + 'px' }" data-testid="agent-panel"><div class="resizer left" data-testid="agent-resizer" @mousedown="startResize('agent', $event)" /><AgentPanel ref="agentPanel" @close="toggleAgent" /></aside>
    </div>
    <Toasts />
    <footer class="statusbar small" data-testid="statusbar"><button v-if="activeJobs || app.jobs.failed || app.jobs.waitingModel" class="ghost status-item" data-testid="jobs-status" @click="app.showJobs = !app.showJobs"><span v-if="activeJobs" data-testid="jobs-active">{{ t.jobs.processing(activeJobs) }}</span><span v-if="app.jobs.waitingModel" class="warn" data-testid="jobs-waiting">{{ t.jobs.waitingModel(app.jobs.waitingModel) }}</span><span v-if="app.jobs.failed" class="bad" data-testid="jobs-failed">{{ t.jobs.failed(app.jobs.failed) }}</span></button><span class="grow selectable faint">{{ app.vault.path }}</span><button class="ghost status-item" :class="app.modelState" data-testid="model-status" :data-state="app.modelState" @click="app.settingsSection = 'model'; app.showSettings = true">{{ modelText }}</button></footer>
    <input ref="picker" type="file" multiple hidden data-testid="library-picker" @change="onPicked" />
    <div v-if="dropping" class="drop-overlay" data-testid="drop-overlay">{{ t.archive.dropHint }}</div>
    <CommandPalette v-if="commands.paletteOpen" /><QuickOpen v-if="showQuickOpen" @close="showQuickOpen = false" /><JobsPopover v-if="app.showJobs" @close="app.showJobs = false" @archive="openArchive" @review="openReview" />
  </div>
</template>

<style scoped>
.shell { height:100%; display:flex; flex-direction:column; background:var(--canvas); }
.topbar { height:var(--topbar-height); flex:none; display:flex; align-items:center; padding:0 var(--space-5); gap:var(--space-5); }
.brand { display:flex; align-items:center; gap:var(--space-3); width:190px; flex:none; }
.brand > span { display:grid; place-items:center; width:var(--space-6); height:var(--space-6); color:var(--on-accent); background:var(--accent); font-size:22px; font-weight:650; border-radius:var(--radius-m); }
.brand strong { font-size:24px; letter-spacing:-1px; }
.primary-nav { display:flex; padding:var(--space-1); border:1px solid var(--border); border-radius:var(--radius-m); background:var(--bg-primary); margin-right:auto; }
.primary-nav button { display:flex; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); white-space:nowrap; }
.primary-nav [aria-current='page'] { color:var(--accent); background:var(--accent-soft); font-weight:600; }
.actions { display:flex; align-items:center; gap:var(--space-2); }
.actions > button { background:var(--bg-primary); }
.actions .new-note { display:flex; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); }
.tasks-button { display:flex; align-items:center; gap:var(--space-2); font-size:var(--font-size-small); }
.tasks-button[aria-expanded="true"] { color:var(--accent); background:var(--accent-soft); }
.task-count { min-width:18px; padding:0 var(--space-1); border-radius:var(--radius-s); background:var(--accent-soft); color:var(--accent); font-size:var(--font-size-small); }
.task-alert { width:6px; height:6px; border-radius:50%; background:var(--danger); }
.tools { position:relative; }
.tools-menu { position:absolute; top:100%; right:0; width:224px; padding:var(--space-2); border:1px solid var(--border); border-radius:var(--radius-m); background:var(--bg-primary); box-shadow:var(--shadow); z-index:50; }
.tools-menu button { display:flex; width:100%; text-align:left; justify-content:space-between; gap:var(--space-2); align-items:center; }
.tools-menu kbd { font:var(--font-size-small) var(--font-mono); color:var(--text-muted); }
.body { flex:1; min-height:0; display:flex; gap:var(--space-3); margin:0 var(--space-4); }
.body:has(> .quick-rail) { margin-left:0; }
.surface { background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-l); }
.side, .agent { flex:none; position:relative; display:flex; flex-direction:column; min-width:0; }
.agent { overflow:hidden; }
.side { flex-shrink:0; }
.workspace-sidebar { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.content { flex:1; min-width:0; display:flex; flex-direction:column; container:content / inline-size; overflow:hidden; }
.panel-title { height:var(--tabbar-height); display:flex; align-items:center; justify-content:space-between; padding:0 var(--space-3); border-bottom:1px solid var(--border); flex:none; font-size:var(--font-size-small); }
.resizer { position:absolute; top:0; bottom:0; width:5px; cursor:col-resize; z-index:5; }
.resizer.right { right:-3px; }.resizer.left { left:0; }.resizer:hover { background:var(--accent-soft); }
.tabbar { flex:none; height:var(--tabbar-height); display:flex; align-items:center; padding:0 var(--space-3); gap:var(--space-1); border-bottom:1px solid var(--border); overflow-x:auto; }
.tab { display:flex; align-items:center; height:30px; max-width:190px; padding:0 var(--space-1); border-radius:var(--radius-s); color:var(--text-muted); }
.tab.active { color:var(--accent); background:var(--accent-soft); }
.tab-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 var(--space-2); font-size:var(--font-size-small); color:inherit; }
.tab-close { display:grid; place-items:center; padding:2px; min-height:0; color:var(--text-faint); }
.side-toggle { color:var(--text-muted); flex:none; }
.stage { flex:1; min-height:0; position:relative; overflow:auto; }
.content-empty { height:100%; display:grid; place-items:center; }
.capture-bar { flex:none; padding:var(--space-3) var(--space-6) var(--space-4); background:var(--bg-primary); }
.statusbar { height:var(--statusbar-height); flex:none; display:flex; align-items:center; gap:var(--space-3); padding:0 var(--space-5); font-size:var(--font-size-small); }
.grow { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.status-item { padding:0 var(--space-1); min-height:0; font-size:inherit; color:var(--text-muted); }
.warn, .not-configured, .unavailable { color:var(--warning); }.bad { color:var(--danger); }
.drop-overlay { position:fixed; inset:0; z-index:150; display:grid; place-items:center; background:var(--accent-soft); border:2px dashed var(--accent); color:var(--accent); font-size:var(--font-size-title); pointer-events:none; }
@media (max-width:1100px) { .brand { width:auto; } .topbar { gap:var(--space-4); padding:0 var(--space-4); } .capture-bar { padding:var(--space-3) var(--space-4); } }
@media (max-width:800px) { .brand strong, .new-note span { display:none; } .actions { gap:var(--space-1); } .topbar { gap:var(--space-2); } }
</style>
