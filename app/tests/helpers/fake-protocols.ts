import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ModelProtocol } from '../../shared/model-protocol'
import type { FakeChatRequest, FakeLlm, FakeReply, FakeResponder } from './fake-llm'

interface WireItem {
  type?: string; role?: string; content?: string | WireItem[]; text?: string; output?: unknown
  name?: string; arguments?: string; input?: unknown; tool_use_id?: string
}
export interface WireRequest {
  model: string; input?: WireItem[]; messages?: WireItem[]; system?: string | WireItem[]; tools?: unknown[]
  reasoning?: { effort: string }; thinking?: { type: string; budget_tokens?: number }; output_config?: { effort: string }
  max_tokens?: number; max_output_tokens?: number; store?: boolean
}
export interface ProtocolLlm extends FakeLlm { wireRequests: { url: string; headers: http.IncomingHttpHeaders; body: WireRequest }[] }

function normalized(body: WireRequest): FakeChatRequest {
  const messages: FakeChatRequest['messages'] = []
  if (body.system) messages.push({ role: 'system', content: body.system })
  for (const item of body.input ?? body.messages ?? []) {
    if (item.type === 'function_call_output') messages.push({ role: 'tool', content: item.output })
    else if (item.type === 'function_call') messages.push({ role: 'assistant', content: '' })
    else if (Array.isArray(item.content) && item.content.some(block => block.type === 'tool_result')) {
      for (const block of item.content) if (block.type === 'tool_result') messages.push({ role: 'tool', content: block.content })
    } else messages.push({ role: item.role === 'developer' ? 'system' : item.role ?? 'user', content: item.content })
  }
  return { model: body.model, messages, tools: body.tools }
}

function respond(res: http.ServerResponse, protocol: ModelProtocol, body: WireRequest, reply: Exclude<FakeReply, { status: number; body: string }>, index: number) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (type: string, fields: object) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n')
  const id = 'fixture-' + index, callId = 'call_' + index
  if (protocol === 'openai-responses') {
    const tool = typeof reply !== 'string'
    const argumentsText = tool ? typeof reply.toolCall.arguments === 'string' ? reply.toolCall.arguments : JSON.stringify(reply.toolCall.arguments) : ''
    const item = tool ? { type: 'function_call', id: 'fc_' + index, call_id: callId, name: reply.toolCall.name, arguments: argumentsText, status: 'completed' }
      : { type: 'message', id: 'msg_' + index, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] }
    send('response.created', { response: { id, status: 'in_progress' } })
    send('response.output_item.added', { output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } })
    if (tool) {
      send('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: argumentsText })
      send('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: argumentsText })
    } else {
      send('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      send('response.output_text.delta', { output_index: 0, content_index: 0, delta: reply })
    }
    send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } })
  } else {
    send('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    if (typeof reply === 'string') {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } })
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: callId, name: reply.toolCall.name, input: {} } })
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: typeof reply.toolCall.arguments === 'string' ? reply.toolCall.arguments : JSON.stringify(reply.toolCall.arguments) } })
    }
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: typeof reply === 'string' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } })
    send('message_stop', {})
  }
  res.end()
}

export async function startProtocolLlm(protocol: Exclude<ModelProtocol, 'openai-completions'>, initial: FakeResponder = () => '好'): Promise<ProtocolLlm> {
  let responder = initial
  const requests: FakeChatRequest[] = [], wireRequests: ProtocolLlm['wireRequests'] = []
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || new URL(req.url!, 'http://fixture').pathname !== (protocol === 'openai-responses' ? '/v1/responses' : '/v1/messages')) {
      res.writeHead(404).end('unexpected protocol endpoint'); return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireRequest
        const request = normalized(body), index = requests.length
        requests.push(request); wireRequests.push({ url: req.url!, headers: req.headers, body })
        const reply = await responder(request, index)
        if (res.destroyed) return
        if (typeof reply === 'object' && 'status' in reply) res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body)
        else respond(res, protocol, body, reply, index)
      } catch { if (!res.destroyed) res.writeHead(500).end('fixture error') }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', requests, wireRequests,
    setResponder: value => { responder = value },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}
