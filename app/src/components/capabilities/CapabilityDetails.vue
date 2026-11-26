<script setup lang="ts">
import { computed } from 'vue'
import { missingSkillTools } from '@shared/capabilities'
import { AlertCircle, ChevronRight, Sparkles } from 'lucide-vue-next'
import { useCapabilitiesStore } from '@/stores/capabilities'
import type { CapabilityPage } from '@/capabilities/model'
import { agentIcon, agentSource, skillSource, toolIcon } from '@/capabilities/presentation'
import { t } from '@/strings'
import CapabilityHeader from './CapabilityHeader.vue'
import CapabilityLinks from './CapabilityLinks.vue'
import CapabilityTools from './CapabilityTools.vue'
const { kind, id } = defineProps<{ kind: Exclude<CapabilityPage, 'runs' | 'plugins'>; id: string }>()
const emit = defineEmits<{ open: [page: CapabilityPage, id: string] }>()
const cap = useCapabilitiesStore()
const c = t.capabilities
const agent = computed(() => kind === 'agents' ? cap.agents.find(entry => entry.id === id) : undefined)
const skill = computed(() => kind === 'skills' ? cap.skills.find(entry => entry.id === id) : undefined)
const tool = computed(() => kind === 'tools' ? cap.catalog?.tools.find(entry => entry.id === id) : undefined)
const item = computed(() => agent.value ?? skill.value ?? tool.value)
const title = computed(() => agent.value?.name ?? skill.value?.title ?? tool.value?.title ?? '')
const source = computed(() => agent.value ? agentSource(agent.value) : skill.value ? skillSource(skill.value) : undefined)
const problems = computed(() => {
  if (agent.value?.enabled) return cap.problems(id)
  if (!skill.value) return []
  const allTools = cap.catalog?.tools.filter(tool => !tool.loader && tool.enabled).map(tool => tool.id) ?? []
  const missing = missingSkillTools(skill.value, allTools)
  return missing.length ? [c.missingTools(skill.value.title, missing.join('、'))] : []
})
const status = computed(() => tool.value ? !tool.value.enabled ? c.disabled : tool.value.access === 'loader' ? c.filters.loader : tool.value.access === 'write' ? c.writable : c.readonly : !(agent.value ?? skill.value)?.enabled ? c.disabled : problems.value.length ? c.needsAttention : c.enabled)
const tone = computed(() => tool.value || !(agent.value ?? skill.value)?.enabled ? 'muted' : problems.value.length ? 'warning' : 'success')
const users = computed(() => cap.agents.filter(entry => kind === 'skills' ? entry.skillIds.includes(id) : tool.value?.loader ? entry.skillIds.length > 0 : entry.toolIds.includes(id)))
const userLinks = computed(() => users.value.map(entry => ({ id: entry.id, title: entry.name, description: entry.description, icon: agentIcon(entry.id) })))
const skillLinks = computed(() => (agent.value?.skillIds ?? []).map(skillId => {
  const entry = cap.skills.find(s => s.id === skillId)
  return { id: skillId, title: entry?.title ?? skillId, description: entry?.description ?? c.missingSkill, icon: Sparkles, warning: !entry ? c.missingBinding : !entry.enabled ? c.disabled : undefined }
}))
const output = computed(() => tool.value ? (c.toolOutputs as Record<string, string>)[tool.value.id] ?? c.toolOutput : '')
const accessScope = computed(() => tool.value?.id === 'calculator' ? c.calculatorScope : tool.value?.access === 'loader' ? c.loaderScope : tool.value?.access === 'write' ? c.writeScope : c.readScope)
</script>
<template>
  <article v-if="item" class="cap-detail" data-testid="cap-detail">
    <CapabilityHeader :icon="agent ? agentIcon(id) : skill ? Sparkles : toolIcon(id)" :title :description="item.description" :source :status :tone><template #actions><slot name="actions" /></template></CapabilityHeader>
    <div v-if="problems.length || skill && !skill.enabled" class="cap-notice" data-testid="cap-problems"><AlertCircle :size="15" /><div><p v-for="problem in problems" :key="problem">{{ problem }}</p><p v-if="skill && !skill.enabled">{{ c.disabled }}。{{ skill.pluginId ? c.pluginEnableHint : c.dependencyHint }}</p></div></div>
    <button v-if="agent?.pluginId || skill?.pluginId" class="ghost cap-package-link" data-testid="cap-owner-plugin" @click="emit('open', 'plugins', (agent?.pluginId ?? skill?.pluginId)!)">
      {{ c.openPlugin }}
    </button>
    <template v-if="agent">
      <section class="cap-section"><h3>{{ c.instructions }}</h3><div class="cap-instruction selectable">{{ agent.instructions }}</div></section>
      <section class="cap-section"><h3>{{ c.skills }}<span class="cap-count">{{ agent.skillIds.length }}</span></h3><CapabilityLinks v-if="skillLinks.length" :items="skillLinks" @open="emit('open', 'skills', $event)" /><p v-else class="small muted">{{ c.noSkills }}</p></section>
      <section class="cap-section"><h3>{{ c.tools }}<span class="cap-count">{{ agent.toolIds.length }}</span></h3><p class="cap-section-caption">{{ c.toolCaption }}</p><CapabilityTools :ids="agent.toolIds" @open="emit('open', 'tools', $event)" /></section>
      <details class="cap-disclosure" data-testid="cap-source-config"><summary><ChevronRight :size="13" />{{ c.sourceConfig }}</summary><dl class="cap-metadata"><dt>{{ c.source }}</dt><dd>{{ source }}</dd><dt>{{ c.identifier }}</dt><dd><code>{{ agent.id }}</code></dd><dt>{{ c.modelPolicy }}</dt><dd>{{ c.globalModel }}</dd></dl><details v-if="agent.id === 'default'" class="cap-disclosure"><summary><ChevronRight :size="13" />{{ c.systemPrompt }}</summary><pre class="cap-code selectable">{{ cap.catalog?.prompt }}</pre></details></details>
    </template>
    <template v-else-if="skill">
      <ul v-if="skill.warnings?.length || skill.manualOnly" class="cap-skill-warnings" data-testid="cap-skill-warnings">
        <li v-if="skill.manualOnly">{{ c.manualSkill }}</li>
        <li v-for="warning in skill.warnings" :key="warning">{{ warning }}</li>
      </ul>
      <section class="cap-section"><h3>{{ c.instructionsTitle.skills }}</h3><div class="cap-instruction selectable">{{ skill.body }}</div></section>
      <section class="cap-section"><h3>{{ c.dependencies }}<span v-if="skill.requiredTools" class="cap-count">{{ skill.requiredTools.length }}</span></h3><p class="cap-section-caption">{{ c.dependencyCaption }}</p><CapabilityTools v-if="skill.requiredTools !== null" :ids="skill.requiredTools" @open="emit('open', 'tools', $event)" /><p v-else class="small muted">{{ c.noDependency }}</p></section>
      <section class="cap-section"><h3>{{ c.usedBy }}<span class="cap-count">{{ users.length }}</span></h3><CapabilityLinks v-if="users.length" :items="userLinks" @open="emit('open', 'agents', $event)" /><p v-else class="small muted">{{ c.noUsers }}</p></section>
      <details class="cap-disclosure"><summary><ChevronRight :size="13" />{{ c.identifierSource }}</summary><dl class="cap-metadata"><dt>{{ c.skillIdentifier }}</dt><dd><code>{{ skill.id }}</code></dd><dt>{{ c.skillReference }}</dt><dd><code class="cap-inline-code">/{{ skill.id }}</code></dd><dt>{{ c.source }}</dt><dd>{{ source }}</dd><template v-if="skill.path"><dt>{{ c.location }}</dt><dd>{{ skill.path }}</dd></template></dl></details>
    </template>
    <template v-else-if="tool">
      <p class="cap-section-caption">{{ c.toolConfigurationHint }}</p>
      <section class="cap-section"><h3>{{ c.accessScope }}</h3><div class="cap-instruction selectable">{{ accessScope }}</div></section>
      <section class="cap-section"><h3>{{ c.output }}</h3><p class="cap-section-text selectable">{{ output }}</p></section>
      <section class="cap-section"><h3>{{ c.usedBy }}<span class="cap-count">{{ users.length }}</span></h3><CapabilityLinks v-if="users.length" :items="userLinks" @open="emit('open', 'agents', $event)" /><p v-else class="small muted">{{ c.noUsers }}</p></section>
      <details class="cap-disclosure" data-testid="cap-tool-parameters"><summary><ChevronRight :size="13" />{{ c.toolParameters }}</summary><dl class="cap-metadata"><dt>{{ c.identifier }}</dt><dd><code>{{ tool.id }}</code></dd><dt>{{ c.source }}</dt><dd>{{ c.toolListHint }}</dd></dl><pre class="cap-code selectable">{{ tool.parameters }}</pre></details>
    </template>
  </article>
</template>
