export const COMPACTION_THRESHOLDS = [0.6, 0.7, 0.8] as const
export type CompactionThreshold = typeof COMPACTION_THRESHOLDS[number]
export const DEFAULT_COMPACTION_THRESHOLD: CompactionThreshold = 0.7
export const CONTEXT_WINDOW_PRESETS = [
  { label: '8K', tokens: 8192 }, { label: '16K', tokens: 16384 },
  { label: '32K', tokens: 32768 }, { label: '64K', tokens: 65536 },
  { label: '128K', tokens: 131072 }, { label: '200K', tokens: 200000 },
  { label: '256K', tokens: 262144 }, { label: '512K', tokens: 524288 },
  { label: '1M', tokens: 1000000 }, { label: '2M', tokens: 2000000 },
] as const

/** 窗口留空自动；输出预算始终由程序计算，不接受手动设置。 */
export interface ModelBudgetOverrides {
  contextWindow?: number
  compactionThreshold?: CompactionThreshold
}
export const MODEL_BUDGET_BOUNDS = { contextWindow: { min: 4096, max: 2_000_000 } } as const

export const safetyTokens = (window: number): number => Math.max(256, Math.min(8192, Math.ceil(window * 0.05)))
export interface ResolvedModelBudget {
  contextWindow: number
  maxOutputTokens: number
  source: 'catalog' | 'default' | 'custom'
  compactionThreshold: CompactionThreshold
}

/** 最近一次请求的估算，不代表整段历史的大小或模型返回的精确计费量。 */
export interface ContextBudget extends ResolvedModelBudget {
  model: string
  safetyTokens: number
  inputBudget: number
  inputTokens: number
  percent: number
  historyTurns: number
  omittedHistoryTurns: number
  summarizedTurns?: number
  blocked: boolean
}
