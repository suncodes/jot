import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ModelListRequest { url: string; headers: http.IncomingHttpHeaders }
export interface ModelListReply { status?: number; body: unknown; headers?: Record<string, string> }
export type ModelListResponder = (request: ModelListRequest, index: number) => ModelListReply | Promise<ModelListReply>

/** 模型目录专用本地服务，验证真实 GET、鉴权、分页和错误响应。 */
export async function startModelList(initial: ModelListResponder) {
  let responder = initial
  const requests: ModelListRequest[] = []
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const request = { url: req.url!, headers: req.headers }, index = requests.length
    requests.push(request)
    try {
      const reply = await responder(request, index)
      if (!res.destroyed) res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' })
        .end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
    } catch { if (!res.destroyed) res.writeHead(500).end('fixture error') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', requests,
    setResponder(value: ModelListResponder) { responder = value },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}
