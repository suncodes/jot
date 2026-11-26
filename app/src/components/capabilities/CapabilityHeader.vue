<script setup lang="ts">
import type { Component } from 'vue'
import type { CapabilityTone } from '@/capabilities/presentation'
defineProps<{ icon: Component; title: string; description?: string; source?: string; status: string; tone?: CapabilityTone }>()
</script>
<template>
  <header class="cap-entity" data-object-row>
    <span class="cap-avatar"><component :is="icon" :size="23" :stroke-width="1.5" /></span>
    <div class="cap-entity-heading"><div class="cap-title-line"><h2>{{ title }}</h2><span v-if="source" class="cap-source">{{ source }}</span><span class="cap-badge" :class="tone">{{ status }}</span></div><p v-if="description" class="cap-description selectable">{{ description }}</p></div>
    <div class="cap-entity-actions"><slot name="actions" /></div>
  </header>
</template>
