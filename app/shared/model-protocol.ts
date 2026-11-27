export const MODEL_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type ModelProtocol = typeof MODEL_PROTOCOLS[number]
export const DEFAULT_MODEL_PROTOCOL: ModelProtocol = 'openai-completions'

export interface ModelEndpoint {
  id?: string
  baseUrl: string
  model: string
  protocol?: ModelProtocol
}

export function protocolBaseUrl(endpoint: Pick<ModelEndpoint, 'baseUrl' | 'protocol'>): string {
  const base = endpoint.baseUrl.trim().replace(/\/+$/, '')
  return endpoint.protocol === 'anthropic-messages' ? base.replace(/\/v1$/, '') : base
}

export function matchesModelProtocol(config: ModelEndpoint, api: string | undefined): boolean {
  const protocol = config.protocol ?? DEFAULT_MODEL_PROTOCOL
  if (!api || api === protocol) return true
  try {
    return protocol === 'openai-completions' && api === 'openai-responses' && new URL(config.baseUrl).origin === 'https://api.openai.com'
  } catch { return false }
}
