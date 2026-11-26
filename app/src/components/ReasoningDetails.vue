<script setup lang="ts">
import type { ResolvedReasoning } from '@shared/reasoning'
import { t } from '@/strings'
defineProps<{ reasoning: ResolvedReasoning }>()
</script>
<template>
  <dl class="reasoning-details small" data-testid="reasoning-details">
    <dt>{{ t.reasoning.requested }}</dt><dd>{{ t.reasoning.labels[reasoning.requested] }}</dd>
    <dt>{{ t.reasoning.source }}</dt><dd>{{ t.reasoning.sources[reasoning.source] }}</dd>
    <dt>{{ t.reasoning.parameter }}</dt><dd class="selectable">{{ reasoning.parameters ? Object.entries(reasoning.parameters).map(([name, value]) => name + ': ' + JSON.stringify(value)).join('；') : reasoning.requested === 'auto' ? t.reasoning.noParameter : t.reasoning.notSent }}</dd>
    <dt>{{ t.reasoning.reported }}</dt><dd>{{ reasoning.reported ?? t.reasoning.notReported }}</dd>
  </dl>
</template>
<style scoped>
.reasoning-details { display:grid; grid-template-columns:80px minmax(0,1fr); gap:var(--space-2) var(--space-3); margin:var(--space-3) 0; line-height:1.7; }
dt { color:var(--text-muted); }
dd { margin:0; overflow-wrap:anywhere; }
</style>