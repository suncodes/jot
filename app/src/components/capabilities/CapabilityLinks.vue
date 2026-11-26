<script setup lang="ts">
import type { Component } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
defineProps<{ items: { id: string; title: string; description: string; icon: Component; warning?: string }[] }>()
const emit = defineEmits<{ open: [id: string] }>()
</script>
<template>
  <div class="cap-links"><button v-for="item in items" :key="item.id" class="cap-link" @click="emit('open', item.id)"><component :is="item.icon" :size="16" /><span class="cap-link-info"><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span><span v-if="item.warning" class="cap-badge warning">{{ item.warning }}</span><ChevronRight :size="15" /></button></div>
</template>
