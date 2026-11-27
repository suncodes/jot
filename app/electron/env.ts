import fs from 'node:fs'
import path from 'node:path'
import type { ModelBudgetOverrides } from '@shared/model-budget'
import type { ReasoningEffort } from '@shared/reasoning'
import { DEFAULT_MODEL_PROTOCOL, MODEL_PROTOCOLS, type ModelProtocol } from '@shared/model-protocol'
import { JotError } from '@shared/result'

export interface ModelConfig extends ModelBudgetOverrides {
  id?: string
  name?: string
  channelId?: string
  channelName?: string
  protocol?: ModelProtocol
  reasoningEffort?: ReasoningEffort
  baseUrl: string
  apiKey: string
  model: string
}

function parseDotEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && m[1]) out[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * 开发期的模型默认配置：先看进程环境变量，再看工作区根目录的 .env。
 * 只在开发模式下调用；打包后的软件不读 .env。见 docs/architecture.md。
 */
export function loadDevModelDefaults(repoRoot: string, env: NodeJS.ProcessEnv = process.env): ModelConfig | null {
  const file = env.JOT_NO_DOTENV === '1' ? {} : parseDotEnv(path.join(repoRoot, '.env'))
  const pick = (k: string) => (env[k] || file[k] || '').trim()
  const baseUrl = pick('JOT_LLM_BASE_URL')
  const apiKey = pick('JOT_LLM_API_KEY')
  const model = pick('JOT_LLM_MODEL')
  if (!baseUrl || !model) return null
  const protocol = pick('JOT_LLM_PROTOCOL') || DEFAULT_MODEL_PROTOCOL
  if (!MODEL_PROTOCOLS.includes(protocol as ModelProtocol)) throw new JotError('INVALID_INPUT', '模型接口协议不受支持：' + protocol)
  return { baseUrl, apiKey, model, protocol: protocol as ModelProtocol }
}
