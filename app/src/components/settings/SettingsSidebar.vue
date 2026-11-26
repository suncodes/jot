<script setup lang="ts">
import { Activity, ArrowLeft, Bot, FolderOpen, Info, Keyboard, NotebookPen, Puzzle, Search, SunMoon } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useAppStore } from '@/stores/app'
import { settingsSections } from '@/settings/sections'
import { t } from '@/strings'
const app = useAppStore()
const query = ref('')
const sections = computed(() => settingsSections(query.value))
const icons = { vault: FolderOpen, appearance: SunMoon, model: Bot, capture: NotebookPen, shortcuts: Keyboard, extensions: Puzzle, storage: Activity, about: Info }
</script>
<template>
  <div class="settings-sidebar" data-testid="settings-sidebar">
    <header><button class="ghost icon-button" :title="t.settings.backWorkspace" :aria-label="t.settings.backWorkspace" data-testid="settings-back" @click="app.showSettings = false"><ArrowLeft :size="16" /></button><strong>{{ t.settings.title }}</strong></header>
    <label class="settings-search"><Search :size="15" /><input v-model="query" type="text" :placeholder="t.settings.search" :aria-label="t.settings.search" data-testid="settings-search" /></label>
    <nav :aria-label="t.settings.search">
      <button v-for="id in sections" :key="id" class="ghost" :aria-current="app.settingsSection === id ? 'page' : undefined" :data-testid="'settings-nav-' + id" @click="app.settingsSection = id"><component :is="icons[id]" :size="17" /><span>{{ t.settings.navigation[id] }}</span></button>
      <p v-if="!sections.length" class="small muted">{{ t.settings.noCategories }}</p>
    </nav>
    <p class="settings-sidebar-footer small muted">{{ t.settings.scope }}</p>
  </div>
</template>
<style scoped>
.settings-sidebar { height:100%; min-height:0; display:flex; flex-direction:column; padding:var(--space-4) var(--space-3); gap:var(--space-4); }
header { display:flex; align-items:center; gap:var(--space-2); }
header strong { font-size:var(--font-size-text); }
nav { display:flex; flex:1; min-height:0; overflow:auto; flex-direction:column; gap:var(--space-1); }
nav button { display:flex; align-items:center; gap:var(--space-3); min-height:var(--space-7); padding:var(--space-2) var(--space-3); text-align:left; color:var(--text-muted); }
nav [aria-current='page'] { color:var(--accent); background:var(--accent-soft); font-weight:600; }
nav p { padding:var(--space-2); }
.settings-sidebar-footer { margin:0; padding:var(--space-3) var(--space-2) 0; border-top:1px solid var(--border); }
</style>
