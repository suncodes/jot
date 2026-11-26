// 后台任务沿用现有队列类型；U4／U5 按此绑定切换执行，不新增专项智能体。
export const AI_TASK_KINDS = ['daily', 'summarize-file', 'classify', 'find-synonyms'] as const
export type AiTaskKind = typeof AI_TASK_KINDS[number]
export type TaskSkillBindings = Record<AiTaskKind, string>
export const DEFAULT_TASK_SKILLS: Readonly<TaskSkillBindings> = {
  daily: 'jot-core:daily-review',
  'summarize-file': 'jot-core:source-summary',
  classify: 'jot-core:content-organize',
  'find-synonyms': 'jot-core:term-organize',
}
