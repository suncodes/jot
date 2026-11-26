<script setup lang="ts">
import { computed } from 'vue'
import { Bot, Package, Sparkles } from 'lucide-vue-next'
import type { ManagedPlugin } from '@shared/capabilities'
import { useCapabilitiesStore } from '@/stores/capabilities'
import type { CapabilityPage } from '@/capabilities/model'
import { t } from '@/strings'
import CapabilityHeader from './CapabilityHeader.vue'
import CapabilityLinks from './CapabilityLinks.vue'
import CapabilityTools from './CapabilityTools.vue'

const { plugin } = defineProps<{ plugin: ManagedPlugin }>()
const emit = defineEmits<{ open: [page: CapabilityPage, id: string]; toggle: [] }>()
const cap = useCapabilitiesStore()
const c = t.capabilities
const agents = computed(() => cap.agents.filter(agent => agent.pluginId === plugin.id).map(agent => ({
  id: agent.id, title: agent.name, description: agent.description, icon: Bot,
})))
const skills = computed(() => cap.skills.filter(skill => skill.pluginId === plugin.id).map(skill => ({
  id: skill.id, title: skill.title, description: skill.description, icon: Sparkles,
})))
</script>

<template>
  <article class="cap-detail" data-testid="cap-plugin-detail">
    <CapabilityHeader :icon="Package" :title="plugin.name" :description="plugin.description"
      :source="plugin.source === 'bundled' ? c.bundledPlugin : c.vaultPlugin"
      :status="!plugin.enabled ? c.disabled : plugin.issues.length ? c.needsAttention : c.enabled"
      :tone="!plugin.enabled ? 'muted' : plugin.issues.length ? 'warning' : 'success'">
      <template #actions><slot name="actions" /><button :disabled="cap.saving" data-testid="cap-plugin-toggle" @click="emit('toggle')">{{ plugin.enabled ? c.disable : c.enable }}</button></template>
    </CapabilityHeader>
    <p class="cap-section-caption">{{ plugin.enabled ? c.pluginDisableHint : c.pluginEnableHint }}</p>
    <div v-if="plugin.issues.length" class="cap-notice" data-testid="cap-plugin-issues">
      <div><p v-for="issue in plugin.issues" :key="issue">{{ issue }}</p></div>
    </div>
    <section class="cap-section"><h3>{{ c.pluginAgents }}<span class="cap-count">{{ agents.length }}</span></h3>
      <CapabilityLinks v-if="agents.length" :items="agents" @open="emit('open', 'agents', $event)" /><p v-else class="small muted">{{ c.noPluginAgents }}</p>
    </section>
    <section class="cap-section"><h3>{{ c.pluginSkills }}<span class="cap-count">{{ skills.length }}</span></h3>
      <CapabilityLinks v-if="skills.length" :items="skills" @open="emit('open', 'skills', $event)" /><p v-else class="small muted">{{ c.noSkills }}</p>
    </section>
    <section class="cap-section"><h3>{{ c.pluginDependencies }}</h3><CapabilityTools :ids="plugin.requiredTools" @open="emit('open', 'tools', $event)" /></section>
    <dl class="cap-metadata"><dt>{{ c.identifier }}</dt><dd><code>{{ plugin.id }}</code></dd></dl>
  </article>
</template>
