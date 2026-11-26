
export type CapabilityPage = 'agents' | 'skills' | 'tools' | 'plugins' | 'runs'
export type { ManagedAgent as PreviewAgent, ManagedSkill as PreviewSkill } from '@shared/capabilities'
import { missingSkillTools } from '@shared/capabilities'
import type { ManagedAgent as PreviewAgent, ManagedSkill as PreviewSkill } from '@shared/capabilities'
export interface DependencyProblem { kind: 'agent' | 'skill' | 'tools'; skill?: string; tools?: string[] }

export function dependencyProblems(agent: Pick<PreviewAgent, 'enabled' | 'skillIds' | 'toolIds'> | undefined, skills: PreviewSkill[], selectedSkill?: string | null): DependencyProblem[] {
  if (!agent?.enabled) return [{ kind: 'agent' }]
  const ids = new Set([...agent.skillIds, ...(selectedSkill ? [selectedSkill] : [])])
  return [...ids].flatMap((id): DependencyProblem[] => {
    const skill = skills.find((item) => item.id === id)
    if (!skill?.enabled) return [{ kind: 'skill', skill: skill?.title ?? id }]
    const missing = missingSkillTools(skill, agent.toolIds)
    return missing.length ? [{ kind: 'tools', skill: skill.title, tools: missing }] : []
  })
}
