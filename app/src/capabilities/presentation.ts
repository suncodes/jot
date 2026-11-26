import { BarChart3, Bot, Calculator, CalendarDays, FileText, History, Layers, Package, Search, Sparkles, Tags, Wrench } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { ManagedAgent, ManagedSkill } from '@shared/capabilities'
import { t } from '@/strings'

export type CapabilityTone = 'success' | 'warning' | 'danger' | 'muted'
export interface CapabilityRow {
  id: string
  title: string
  status: string
  tone: CapabilityTone
  icon: Component
  subtitle?: string
}
export const pageIcons = { agents: Bot, skills: Sparkles, tools: Wrench, plugins: Package, runs: History }
const toolIcons: Record<string, Component> = { calculator: Calculator, search: Search, read: FileText, timeline: CalendarDays, stats: BarChart3, list_directory: Layers, list_tags: Tags, use_skill: Sparkles }
export const toolIcon = (id: string): Component => toolIcons[id] ?? Wrench
export const agentIcon = (_id: string): Component => Bot
export const agentSource = (agent: ManagedAgent): string => agent.id === 'default' ? t.capabilities.currentConfig : agent.pluginId ? t.capabilities.pluginSource : t.capabilities.custom
export const skillSource = (skill: ManagedSkill): string => skill.pluginId ? t.capabilities.pluginSource : t.capabilities.vault
export const formatRunTime = (time: string): string => {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return t.capabilities.notRecorded
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
