<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronRight, Download, Info, Plus, Puzzle, RefreshCw } from 'lucide-vue-next'
import type { AppExtensionImportPreview, AppExtensionImportRequest, AppExtensionPackage, AppExtensionProfile, ManagedAppExtension } from '@shared/app-extensions'
import type { PluginImportPreview } from '@shared/capabilities'
import { extensionCommandId } from '@shared/commands'
import { call } from '@/api'
import { useAppStore } from '@/stores/app'
import { useExtensionsStore } from '@/stores/extensions'
import { useCommandsStore } from '@/stores/commands'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { CAPABILITIES_TAB, useTabsStore } from '@/stores/tabs'
import { useToastsStore } from '@/stores/toasts'
import { t } from '@/strings'
import { commandIcons } from '@/settings/icons'
import AppDialog from '@/components/AppDialog.vue'
import ObjectMenu from '@/components/ObjectMenu.vue'
import ExtensionProfileConfiguration from './ExtensionProfileConfiguration.vue'
import ExtensionAiPluginCard from './ExtensionAiPluginCard.vue'

const { active } = defineProps<{ active: boolean }>()
const commands = useCommandsStore(), app = useAppStore(), extensions = useExtensionsStore(), toasts = useToastsStore(), c = t.extensions
const tab = ref<'installed' | 'bundled'>('installed')
const selected = ref('')
const profileEditor = ref<InstanceType<typeof ExtensionProfileConfiguration> | null>(null)
const editing = ref<{ profile: AppExtensionProfile | null } | null>(null)
const preview = ref<AppExtensionImportPreview | null>(null)
const confirmation = ref<{ pkg: ManagedAppExtension; profile?: AppExtensionProfile } | null>(null)
const error = ref(''), installAi = ref(false), aiPreview = ref<PluginImportPreview | null>(null)
const chosen = computed(() => extensions.catalog.installed.find(pkg => pkg.id === selected.value))
const items = computed<AppExtensionPackage[]>(() => tab.value === 'installed' ? extensions.catalog.installed : extensions.catalog.candidates)
const installed = (id: string) => extensions.catalog.installed.find(pkg => pkg.id === id)
let viewSequence = 0
async function manageAiPlugin(id: string): Promise<void> {
  const capabilities = useCapabilitiesStore()
  if (!await run(() => capabilities.load(true))) return
  capabilities.open('plugins', capabilities.catalog?.plugins.some(plugin => plugin.id === id) ? id : '')
  app.showSettings = false
  void useTabsStore().open(CAPABILITIES_TAB, { newTab: true, title: t.capabilities.title })
}
async function closeAiPreview(): Promise<void> {
  const value = aiPreview.value
  aiPreview.value = null
  if (value) {
    try { await call('extensions:cancelAiPlugin', { token: value.token }) }
    catch (failure) { if (active) error.value = (failure as Error).message }
  }
}
async function previewAiPlugin(): Promise<void> {
  if (!chosen.value || extensions.busy) return
  const current = viewSequence, root = app.vault.path, id = chosen.value.id
  extensions.busy = true; error.value = ''
  try {
    const value = await call('extensions:previewAiPlugin', { id })
    if (current !== viewSequence || root !== app.vault.path || !active) {
      await call('extensions:cancelAiPlugin', { token: value.token }); return
    }
    aiPreview.value = value
  } catch (failure) { if (current === viewSequence) error.value = (failure as Error).message }
  finally { extensions.busy = false }
}
async function confirmAiPlugin(): Promise<void> {
  const value = aiPreview.value
  if (!value) return
  if (await run(() => call('extensions:confirmAiPlugin', { token: value.token }))) {
    aiPreview.value = null; toasts.info(t.extensionAi.installedToast)
  }
}
async function closePreview(): Promise<void> {
  const value = preview.value
  preview.value = null
  if (value) {
    try { await call('extensions:cancelImport', { token: value.token }) }
    catch (e) { if (active) error.value = (e as Error).message }
  }
}
watch(() => active, value => {
  viewSequence++
  if (!value) { void closePreview(); void closeAiPreview(); confirmation.value = null }
  else void extensions.refresh()
})
watch(() => app.vault.path, () => {
  viewSequence++; preview.value = null; aiPreview.value = null; confirmation.value = null; editing.value = null; selected.value = ''; error.value = ''
})
async function run(operation: () => Promise<unknown>): Promise<boolean> {
  if (extensions.busy) return false
  const current = viewSequence, root = app.vault.path
  extensions.busy = true; error.value = ''
  try {
    await operation()
    if (current !== viewSequence || root !== app.vault.path) return false
    await extensions.refresh()
    return current === viewSequence && root === app.vault.path
  }
  catch (e) { error.value = (e as Error).message; return false }
  finally { extensions.busy = false }
}
async function importPackage(request: AppExtensionImportRequest): Promise<void> {
  if (extensions.busy) return
  const current = viewSequence, root = app.vault.path
  extensions.busy = true; error.value = ''
  try {
    const value = await call('extensions:previewImport', request)
    if (current !== viewSequence || root !== app.vault.path || !active) {
      if (value) await call('extensions:cancelImport', { token: value.token })
      return
    }
    installAi.value = false; preview.value = value
  } catch (e) { if (current === viewSequence) error.value = (e as Error).message }
  finally { extensions.busy = false }
}
async function confirmImport(): Promise<void> {
  const value = preview.value
  if (!value) return
  if (await run(() => call('extensions:confirmImport', { token: value.token, installAiPlugin: installAi.value }))) {
    preview.value = null; tab.value = 'installed'
    toasts.info(value.updating ? c.updatedToast : c.installedToast)
  }
}
function configure(id: string): void { selected.value = id; editing.value = null; error.value = '' }
async function enable(pkg: ManagedAppExtension): Promise<void> {
  await run(() => call('extensions:setEnabled', { id: pkg.id, enabled: !pkg.enabled }))
}
function more(action: string, pkg: ManagedAppExtension): void {
  if (action === 'update') void importPackage({ source: { kind: 'local' }, updating: pkg.id })
  else if (action === 'uninstall') confirmation.value = { pkg }
}
async function remove(): Promise<void> {
  const value = confirmation.value
  if (!value) return
  const ok = await run(() => value.profile
    ? call('extensions:removeProfile', { id: value.pkg.id, profileId: value.profile.id })
    : call('extensions:uninstall', { id: value.pkg.id, confirmed: true }))
  if (ok) {
    confirmation.value = null
    if (!value.profile) { selected.value = ''; toasts.info(c.uninstalledToast) }
  }
}
watch([() => commands.configurationTarget, () => active], ([target, visible]) => {
  if (!target || !visible) return
  const pkg = extensions.catalog.installed.find(pkg => pkg.id === target.extensionId)
  const profile = pkg?.profiles.find(profile => profile.id === target.profileId)
  commands.configurationTarget = null
  if (!pkg?.manifest || !profile) { error.value = c.missingProfile; return }
  if (selected.value === pkg.id && editing.value?.profile?.id === profile.id) return
  const open = () => { selected.value = pkg.id; editing.value = { profile }; error.value = '' }
  if (editing.value && profileEditor.value) profileEditor.value.close(open)
  else open()
}, { immediate: true, flush: 'post' })
</script>
<template>
  <div data-testid="settings-extensions">
    <template v-if="editing && chosen?.manifest">
      <ExtensionProfileConfiguration ref="profileEditor" :key="chosen.id + ':' + (editing.profile?.id ?? 'new')" :pkg="chosen" :profile="editing.profile" :active @close="editing = null" />
    </template>
    <template v-else-if="chosen">
      <nav class="settings-breadcrumb"><button class="ghost" data-testid="extensions-back" @click="selected = ''">{{ c.title }}</button><ChevronRight :size="13" /><span>{{ chosen.manifest?.name ?? chosen.id }}</span></nav>
      <header class="settings-heading"><div><h2>{{ chosen.manifest?.name ?? chosen.id }}</h2><p>{{ c.profileHint }}</p></div><span class="settings-badge">{{ t.settings.scope }}</span></header>
      <div v-if="!chosen.enabled" class="settings-note extension-status" data-testid="extension-status"><div class="extension-status-copy"><Info :size="16" /><span>{{ c.stoppedHint }}</span></div><button :disabled="extensions.busy || !chosen.manifest" data-testid="extension-enable-detail" @click="enable(chosen)">{{ c.enable }}</button></div>
      <p v-for="issue in chosen.issues" :key="issue" class="settings-error">{{ issue }}</p>
      <section class="settings-section">
        <div class="profile-section-heading"><h3>{{ c.profiles }}</h3><button class="primary" :disabled="extensions.busy || !chosen.manifest" data-testid="extension-profile-new" @click="editing = { profile: null }"><Plus :size="14" />{{ c.newProfile }}</button></div>
        <div v-for="profile in chosen.profiles" :key="profile.id" class="settings-list-row" data-object-row data-testid="extension-profile" :data-profile="profile.id">
          <div class="settings-list-copy"><strong>{{ profile.name }}</strong><p v-if="'root' in profile.options ? profile.options.root : profile.options.directory">{{ 'root' in profile.options ? profile.options.root : profile.options.directory }}</p><p v-if="!profile.availability.available" class="settings-error">{{ profile.availability.reason }}</p></div>
          <div class="settings-actions">
            <span v-if="extensions.shortcuts.pinned.includes(extensionCommandId(chosen.id, profile.id, profile.commandId))" class="settings-badge">{{ t.shortcuts.pin }}</span>
            <button :disabled="extensions.busy || commands.running.has(extensionCommandId(chosen.id, profile.id, profile.commandId)) || !chosen.enabled || !profile.availability.available" data-testid="extension-profile-execute" @click="commands.execute(extensionCommandId(chosen.id, profile.id, profile.commandId))">{{ c.execute }}</button>
            <button :disabled="extensions.busy || !chosen.manifest" data-testid="extension-profile-edit" @click="editing = { profile }">{{ c.editProfile }}</button>
            <ObjectMenu :label="profile.name" :actions="[{ id: 'delete', label: c.deleteProfile, danger: true, disabled: extensions.busy }]" @select="confirmation = { pkg: chosen!, profile }" />
          </div>
        </div>
        <p v-if="!chosen.profiles.length" class="small muted">{{ c.profileEmpty }}</p>
      </section>
      <ExtensionAiPluginCard v-if="chosen.aiPlugin" :info="chosen.aiPlugin" :busy="extensions.busy" @install="previewAiPlugin" @manage="manageAiPlugin" />
      <section class="settings-card"><h3>{{ c.packageInfo }}</h3><div class="settings-row"><span>{{ c.packageId }}</span><code>{{ chosen.id }}</code></div><div class="settings-row"><span>{{ c.version }}</span><span>{{ chosen.manifest?.version ?? '—' }}</span></div><div class="settings-row"><span>{{ c.actions }}</span><span>{{ chosen.manifest?.commands.map(command => command.name).join('、') }}</span></div></section>
      <button class="ghost" @click="app.settingsSection = 'shortcuts'">{{ c.manageShortcuts }}</button>
    </template>
    <template v-else>
      <header class="settings-heading"><div><h2>{{ c.title }}</h2><p>{{ t.settings.descriptions.extensions }}</p></div><div class="settings-actions"><button class="primary" :disabled="extensions.busy" data-testid="extensions-install-local" @click="importPackage({ source: { kind: 'local' } })"><Download :size="14" />{{ c.localInstall }}</button><button class="ghost icon-button" :disabled="extensions.busy || extensions.loading" :title="c.refresh" :aria-label="c.refresh" data-testid="extensions-refresh" @click="extensions.refresh"><RefreshCw :size="15" /></button></div></header>
      <div class="extension-tabs" role="tablist" :aria-label="c.title"><button role="tab" :aria-selected="tab === 'installed'" data-testid="extensions-tab-installed" @click="tab = 'installed'">{{ c.installed }}<span>{{ extensions.catalog.installed.length }}</span></button><button role="tab" :aria-selected="tab === 'bundled'" data-testid="extensions-tab-bundled" @click="tab = 'bundled'">{{ c.bundled }}<span>{{ extensions.catalog.candidates.length }}</span></button></div>
      <p v-if="extensions.loading && !items.length" class="small muted">{{ c.loading }}</p>
      <div v-else-if="!items.length" class="settings-empty" data-testid="extensions-empty"><Puzzle :size="30" /><h3>{{ tab === 'installed' ? c.installedEmpty : c.bundledEmpty }}</h3><p>{{ c.emptyHint }}</p><button v-if="tab === 'installed'" class="primary" @click="tab = 'bundled'">{{ c.viewBundled }}</button></div>
      <article v-for="pkg in items" :key="pkg.id" class="settings-list-row" data-object-row data-testid="extension-row" :data-extension="pkg.id">
        <div class="extension-icon"><component :is="commandIcons[pkg.manifest?.commands[0]?.icon ?? 'notebook-pen']" :size="22" /></div>
        <div class="settings-list-copy">
          <div class="extension-name"><strong>{{ pkg.manifest?.name ?? pkg.id }}</strong><span v-if="installed(pkg.id)" class="settings-badge">{{ installed(pkg.id)!.enabled ? c.enabled : c.disabled }}</span></div>
          <p>{{ pkg.manifest?.description }}</p>
          <div class="settings-meta"><span v-if="pkg.manifest">v{{ pkg.manifest.version }}</span><span>{{ tab === 'installed' ? c.installed : c.bundled }}</span><span v-if="installed(pkg.id)">{{ c.profileCount(installed(pkg.id)!.profiles.length) }}</span></div>
          <p v-for="issue in pkg.issues" :key="issue" class="settings-error">{{ issue }}</p>
        </div>
        <div v-if="installed(pkg.id)" class="settings-actions">
          <button class="extension-switch" role="switch" :aria-label="(installed(pkg.id)!.enabled ? c.disable : c.enable) + (pkg.manifest?.name ?? pkg.id)" :aria-checked="!!installed(pkg.id)!.enabled" :disabled="extensions.busy || installed(pkg.id)!.enabled === null || !installed(pkg.id)!.manifest" data-testid="extension-toggle" @click="enable(installed(pkg.id)!)"><span /></button>
          <button :disabled="extensions.busy" data-testid="extension-configure" @click="configure(pkg.id)">{{ c.configure }}</button>
          <ObjectMenu :label="pkg.manifest?.name ?? pkg.id" trigger-id="extension-more" :actions="[{ id: 'update', label: c.update, disabled: extensions.busy }, { id: 'uninstall', label: c.uninstall, danger: true, separated: true, disabled: extensions.busy }]" @select="more($event, installed(pkg.id)!)" />
        </div>
        <button v-else class="primary" :disabled="extensions.busy || !pkg.manifest || !!pkg.issues.length" data-testid="extension-install" @click="importPackage({ source: { kind: 'bundled', id: pkg.id } })">{{ c.install }}</button>
      </article>
      <p class="settings-note"><Info :size="16" /><span>{{ c.hint }}</span></p>
    </template>
    <p v-if="error" class="settings-error" role="alert" data-testid="extensions-error">{{ error }}</p>
    <p v-for="issue in extensions.catalog.issues" :key="issue" class="settings-error" role="alert">{{ issue }}</p>
    <p v-if="extensions.error" class="settings-error" role="alert">{{ extensions.error }}</p>

    <AppDialog v-if="preview" :title="preview.updating ? c.previewUpdate : c.previewInstall" :busy="extensions.busy" scroll-body @close="closePreview">
      <h3>{{ preview.manifest.name }}</h3><p class="small muted">{{ preview.manifest.description }}</p>
      <dl class="preview-info"><dt>{{ c.packageId }}</dt><dd><code>{{ preview.manifest.id }}</code></dd><dt>{{ c.version }}</dt><dd>{{ preview.previousVersion ? preview.previousVersion + ' → ' : '' }}{{ preview.manifest.version }}</dd><dt>{{ c.minVersion }}</dt><dd>{{ preview.manifest.minAppVersion }}</dd><dt>{{ c.actions }}</dt><dd>{{ preview.manifest.commands.map(command => command.name).join('、') }}</dd></dl>
      <p class="small muted">{{ preview.updating ? c.updateHint : c.previewHint }}</p>
      <ExtensionAiPluginCard v-if="preview.aiPlugin" v-model:selected="installAi" :info="preview.aiPlugin" :busy="extensions.busy" selectable @manage="manageAiPlugin" />
      <details><summary class="small muted">{{ c.files }}（{{ preview.files.length }}）</summary><ul class="preview-files small selectable"><li v-for="file in preview.files" :key="file.path"><code>{{ file.path }}</code></li></ul></details>
      <details v-if="preview.removedFiles.length"><summary class="small muted">{{ c.removedFiles }}</summary><ul class="preview-files small"><li v-for="file in preview.removedFiles" :key="file"><code>{{ file }}</code></li></ul></details>
      <p v-for="issue in preview.issues" :key="issue" class="settings-error" role="alert">{{ issue }}</p><p v-for="warning in preview.warnings" :key="warning" class="small muted">{{ warning }}</p>
      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
      <template #footer><div class="dialog-actions"><button :disabled="extensions.busy" @click="closePreview">{{ t.common.cancel }}</button><button class="primary" :disabled="extensions.busy || !!preview.issues.length" data-testid="extension-import-confirm" @click="confirmImport">{{ preview.updating ? c.confirmUpdate : c.confirmInstall }}</button></div></template>
    </AppDialog>
    <AppDialog v-if="aiPreview" :title="t.extensionAi.previewTitle" :busy="extensions.busy" scroll-body @close="closeAiPreview">
      <h3>{{ aiPreview.name }}</h3><p class="small muted">{{ aiPreview.description }}</p><code>{{ aiPreview.id }}</code>
      <p class="small muted">{{ t.extensionAi.installHint }}</p>
      <details><summary class="small muted">{{ c.files }}（{{ aiPreview.files.length }}）</summary><ul class="preview-files small selectable"><li v-for="file in aiPreview.files" :key="file"><code>{{ file }}</code></li></ul></details>
      <p v-for="issue in aiPreview.issues" :key="issue" class="settings-error">{{ issue }}</p>
      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
      <template #footer><div class="dialog-actions"><button :disabled="extensions.busy" @click="closeAiPreview">{{ t.common.cancel }}</button><button class="primary" :disabled="extensions.busy" data-testid="extension-ai-confirm" @click="confirmAiPlugin">{{ c.confirmInstall }}</button></div></template>
    </AppDialog>
    <AppDialog v-if="confirmation" :title="confirmation.profile ? c.deleteTitle : c.uninstallTitle" :busy="extensions.busy" compact @close="confirmation = null"><p>{{ confirmation.profile ? c.deleteHint : c.uninstallHint }}</p><strong>{{ confirmation.profile?.name ?? confirmation.pkg.manifest?.name ?? confirmation.pkg.id }}</strong><p v-if="error" class="settings-error" role="alert">{{ error }}</p><div class="dialog-actions"><button :disabled="extensions.busy" @click="confirmation = null">{{ t.common.cancel }}</button><button class="primary" :disabled="extensions.busy" data-testid="extension-remove-confirm" @click="remove">{{ confirmation.profile ? c.deleteProfile : c.uninstall }}</button></div></AppDialog>
  </div>
</template>
<style scoped>
.extension-status { align-items:center; justify-content:space-between; padding:var(--space-4); border:1px solid var(--border); border-radius:var(--radius-m); background:var(--bg-secondary); }
.extension-status-copy { display:flex; align-items:center; gap:var(--space-2); min-width:0; line-height:1.6; }
.extension-status-copy svg, .extension-status > button { flex:none; }
.settings-list-copy .settings-error { color:var(--danger); }
@container content (max-width:600px) {
  .extension-status { flex-direction:column; align-items:stretch; }
  .extension-status > button { align-self:flex-start; }
}
.extension-tabs { display:flex; gap:var(--space-5); border-bottom:1px solid var(--border); margin-bottom:var(--space-2); }
.extension-tabs button { border:0; border-bottom:2px solid transparent; border-radius:0; padding:var(--space-3) var(--space-1); background:transparent; color:var(--text-muted); display:flex; align-items:center; gap:var(--space-2); }
.extension-tabs button[aria-selected='true'] { color:var(--accent); border-bottom-color:var(--accent); font-weight:600; }
.extension-tabs span { font-size:var(--font-size-small); }
.extension-icon { width:var(--space-8); height:var(--space-8); flex:none; display:grid; place-items:center; background:var(--accent-soft); color:var(--accent); border-radius:var(--radius-m); }
.extension-name { display:flex; align-items:center; flex-wrap:wrap; gap:var(--space-2); }
.extension-switch { padding:3px; width:34px; height:20px; min-height:0; border:1px solid var(--border); background:var(--bg-active); border-radius:20px; }
.extension-switch > span { display:block; width:12px; height:12px; border-radius:50%; background:var(--text-muted); }
.extension-switch[aria-checked='true'] { background:var(--accent-soft); border-color:var(--accent); }
.extension-switch[aria-checked='true'] > span { margin-left:auto; background:var(--accent); }
.profile-section-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); }
.profile-section-heading button { display:flex; gap:var(--space-1); align-items:center; }
.profile-section-heading h3 { margin:0; }
.preview-info { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--space-2) var(--space-4); font-size:var(--font-size-small); }
.preview-info dt { color:var(--text-muted); }.preview-info dd { margin:0; overflow-wrap:anywhere; }
.preview-files { padding-left:var(--space-4); max-height:180px; overflow:auto; }
</style>
