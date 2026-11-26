import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeChatRequest {
  model: string
  messages: { role: string; content: unknown }[]
  stream?: boolean
  tools?: unknown[]
  reasoning_effort?: string
  thinking?: unknown
  response_format?: unknown
  max_tokens?: number
  max_completion_tokens?: number
}

/** 一次回复：纯文本，或一个工具调用 */
export type FakeReply = string | { toolCall: { name: string; arguments: Record<string, unknown> | string }; content?: string } | { status: number; body: string }

export type FakeResponder = (req: FakeChatRequest, index: number) => FakeReply | Promise<FakeReply>

export interface FakeLlm {
  /** OpenAI 兼容接口的地址，形如 http://127.0.0.1:端口/v1 */
  baseUrl: string
  requests: FakeChatRequest[]
  setResponder(responder: FakeResponder): void
  close(): Promise<void>
}

/**
 * 本地假模型服务：实现 /chat/completions（支持流式和非流式），回复内容由测试指定。
 * 自动化测试用它代替真实模型，结果固定、不花钱。
 */
export async function startFakeLlm(initial: FakeResponder = () => '好'): Promise<FakeLlm> {
  let responder = initial
  const requests: FakeChatRequest[] = []

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as FakeChatRequest
      const index = requests.length
      requests.push(body)
      const reply = await responder(body, index)
      if (res.destroyed) return

      if (typeof reply === 'object' && 'status' in reply) {
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body)
        return
      }
      const id = `fake-${requests.length}`
      const base = { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model }
      const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      const toolCalls =
        typeof reply === 'object'
          ? [{ id: `call_${requests.length}`, type: 'function', function: { name: reply.toolCall.name, arguments: typeof reply.toolCall.arguments === 'string' ? reply.toolCall.arguments : JSON.stringify(reply.toolCall.arguments) } }]
          : undefined

      if (!body.stream) {
        const message = toolCalls ? { role: 'assistant', content: typeof reply === 'object' && 'toolCall' in reply ? reply.content ?? null : null, tool_calls: toolCalls } : { role: 'assistant', content: reply }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      send({ role: 'assistant', content: '' })
      if (toolCalls) {
        if (typeof reply === 'object' && 'toolCall' in reply && reply.content) send({ content: reply.content })
        if (typeof reply === 'object' && 'toolCall' in reply && typeof reply.toolCall.arguments === 'string') {
          const first = toolCalls[0]!
          send({ tool_calls: [{ index: 0, ...first, function: { name: first.function.name, arguments: '' } }] })
          for (let at = 0; at < first.function.arguments.length; at += 97) send({ tool_calls: [{ index: 0, function: { arguments: first.function.arguments.slice(at, at + 97) } }] })
        } else send({ tool_calls: toolCalls.map((t, index) => ({ index, ...t })) })
        send({}, 'tool_calls')
      } else {
        // 分几段发，模拟流式输出
        const text = reply as string
        const size = Math.max(1, Math.ceil(text.length / 4))
        for (let i = 0; i < text.length; i += size) send({ content: text.slice(i, i + size) })
        send({}, 'stop')
      }
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setResponder: (r) => (responder = r),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** 摘要与助手共用 Pi 请求入口，按固定系统职责区分，便于验证后台流量。 */
export const isCompactionRequest = (req: FakeChatRequest): boolean => JSON.stringify(req.messages[0]?.content).includes('你是对话压缩器')

/** 请求是不是 AI 助手发的（带工具定义） */
export const isAgentRequest = (req: FakeChatRequest): boolean => Array.isArray(req.tools) && req.tools.length > 0 && !JSON.stringify(req.messages[0]?.content).includes('本次为后台任务')

/** 助手请求里已经返回给模型的工具结果，按顺序 */
export function toolResults(req: FakeChatRequest): string[] {
  return req.messages
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((c: { text?: string }) => c.text ?? '').join('') : String(m.content ?? '')))
}

/** 工具结果里出现的片段编号 */
export const chunkIds = (text: string): string[] => [...text.matchAll(/\[([0-9a-f]{6})\]/g)].map((m) => m[1]!)

/**
 * 助手的回复脚本：steps 里的每一步对应“已经有几个工具结果”时模型该回什么。
 * 不是助手发的请求（流水线、测试连接）一律交给 other。
 */
export function agentScript(steps: ((results: string[], req: FakeChatRequest) => FakeReply | Promise<FakeReply>)[], other: FakeResponder = () => '好'): FakeResponder {
  return (req, index) => {
    if (!isAgentRequest(req)) return other(req, index)
    // 只看最后一个用户问题之后的工具结果，这样多轮对话里每一轮都从第一步开始
    const lastUser = req.messages.map((m) => m.role).lastIndexOf('user')
    const results = toolResults({ ...req, messages: req.messages.slice(lastUser + 1) })
    const step = steps[Math.min(results.length, steps.length - 1)]!
    return step(results, req)
  }
}
