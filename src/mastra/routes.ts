import { registerApiRoute } from '@mastra/core/server'
import type { ApiRoute } from '@mastra/core/server'
import { z } from 'zod'
import { getDb } from '../db/client'
import { DeskError } from '../domain/errors'
import { principalFrom } from './principal'
import { type Op, allOps } from './ops'

/** Unwrap optional/default to find what a query-string value should become. */
function kindOf(schema: z.ZodTypeAny | undefined): string | undefined {
  let s: any = schema
  while (s && (s.def?.type === 'optional' || s.def?.type === 'default' || s.def?.type === 'nullable')) {
    s = s.def.innerType
  }
  return s?.def?.type
}

function fromQuery(op: Op, query: Record<string, string>) {
  const shape = (op.input as unknown as z.ZodObject<any>).shape ?? {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query)) {
    const kind = kindOf(shape[k])
    if (kind === 'array') out[k] = v.split(',').filter(Boolean)
    else if (kind === 'boolean') out[k] = v === 'true' || v === '1'
    else if (kind === 'number') out[k] = Number(v)
    else out[k] = v
  }
  return out
}

/** Errors as JSON a client or agent can act on. */
export function toErrorResponse(e: unknown): { status: number; body: { error: string; message: string; issues?: unknown } } {
  if (e instanceof DeskError) return { status: e.status, body: { error: e.code, message: e.message } }
  if (e instanceof z.ZodError) {
    return { status: 400, body: { error: 'invalid', message: 'Invalid input', issues: e.issues } }
  }
  console.error(e)
  return { status: 500, body: { error: 'internal', message: 'Something went wrong' } }
}

function routeFor(op: Op): ApiRoute {
  return registerApiRoute(op.http.path, {
    method: op.http.method,
    openapi: { summary: op.id, description: op.description, tags: [op.audience === 'admin' ? 'Admin' : 'Client'] },
    handler: async (c) => {
      try {
        const principal = principalFrom(c.get('requestContext'))
        const params = c.req.param() as Record<string, string>
        const body =
          op.http.method === 'GET' ? fromQuery(op, c.req.query() as Record<string, string>) : await c.req.json().catch(() => ({}))
        const input = op.input.parse({ ...body, ...params })
        const result = await op.run(getDb(), principal, input)
        return c.json(result ?? { ok: true }, op.http.method === 'POST' ? 201 : 200)
      } catch (e) {
        const { status, body } = toErrorResponse(e)
        return c.json(body, status as 400)
      }
    },
  })
}

export const deskRoutes: ApiRoute[] = [
  registerApiRoute('/health', {
    method: 'GET',
    requiresAuth: false,
    handler: async (c) => c.json({ ok: true }),
  }),
  ...allOps.map(routeFor),
]
