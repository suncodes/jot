<script setup lang="ts">
import { ShieldCheck } from 'lucide-vue-next'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { pageIcons } from '@/capabilities/presentation'
import type { CapabilityPage } from '@/capabilities/model'
import { t } from '@/strings'
import '@/styles/capabilities.css'
const cap = useCapabilitiesStore()
const pages: CapabilityPage[] = ['agents', 'skills', 'tools', 'plugins', 'runs']
const c = t.capabilities
</script>
<template>
  <nav class="agent-navigation" :aria-label="c.title" data-testid="agents-sidebar">
    <div class="agent-navigation-title">{{ c.title }}<span>{{ c.workspace }}</span></div>
    <template v-for="page in pages" :key="page"><div v-if="page === 'runs'" class="agent-navigation-divider" /><button class="ghost" :aria-current="cap.page === page ? 'page' : undefined" :data-testid="'cap-tab-' + page" @click="cap.open(page)"><component :is="pageIcons[page]" :size="17" /><span>{{ c.tabs[page] }}</span></button></template>
    <div class="agent-navigation-footer"><ShieldCheck :size="15" /><div>{{ c.sidebarTitle }}<span>{{ c.sidebarHint }}</span></div></div>
  </nav>
</template>
