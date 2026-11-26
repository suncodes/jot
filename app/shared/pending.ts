import type { ClassificationPatch } from './types'

/** 建议是应用资料；目录待处理是否存在始终由 inbox 的当前物理位置决定。 */
export type SuggestionKind = 'directory' | 'properties'
interface SuggestionBasis { confidence: number; reason: string }
export type ContentSuggestion =
  | (SuggestionBasis & { kind: 'directory'; directoryPath: string })
  | (SuggestionBasis & { kind: 'properties'; properties: ClassificationPatch })
