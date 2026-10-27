/**
 * The desk's MCP Apps view. Every desk tool that shows something opens this one
 * view, and it draws what fits the tool: a request being drafted, a request's
 * tracker, a client's work, the pause calendar, billing, the weekly recap,
 * the new-client form, or Chowderr's command center.
 */
import { app, applyContext, dataOf, draw, esc, hostContext, supersede } from './kit'
import { renderBilling } from './views/billing'
import { renderCommand } from './views/command'
import { type Draft, renderDraft, renderDraftResult } from './views/draft'
import { renderPause, renderPauseDone } from './views/pause'
import { renderRecap } from './views/recap'
import { renderRequest } from './views/request'
import { renderSetup } from './views/setup'
import { renderList, renderStatus } from './views/status'

const ADMIN_TOOLS = new Set(['digest', 'show_board', 'get_client', 'get_request', 'list_requests', 'create_request', 'queue_request', 'start_request', 'deliver_request', 'new_client', 'setup_client', 'weekly_recap', 'send_recap', 'billing_history'])

const toolName = () => hostContext().toolInfo?.tool?.name ?? ''
let redraw: (() => void) | null = null
let streaming = false

function route(data: any) {
  const tool = toolName()
  const admin = ADMIN_TOOLS.has(tool)
  if (data == null || typeof data === 'string') {
    draw(`<div class="card"><p>${esc(data ?? 'Nothing to show.')}</p></div>`)
    return
  }
  if (Array.isArray(data)) return renderList(data, { admin })
  if ('repliesDue' in data && 'clients' in data) return renderCommand(data)
  if ('setup' in data && 'missing' in data) return renderSetup(data)
  if ('payments' in data && 'retainer' in data) return renderBilling(data, { admin })
  if ('shipped' in data && 'upNext' in data) return renderRecap(data, { admin })
  if ('sentTo' in data)
    return draw(`<div class="card"><p>${
      data.sentTo.length ? `Sent ${esc(data.client?.name ?? '')}'s recap to ${esc(data.sentTo.join(', '))}.` : 'No one to send it to: this client has no contact with an email.'
    }</p></div>`)
  if ('draft' in data) return void renderDraftResult(data)
  if ('months' in data) return renderPause(data)
  if ('retainerId' in data && 'month' in data) return void renderPauseDone(data)
  if ('delivered' in data) return renderRequest(data.delivered, { admin: true, banner: 'Delivered. The client can review it now.' })
  if ('active' in data && 'queue' in data && 'client' in data) return renderStatus(data, { admin })
  if ('status' in data && 'id' in data) {
    const banner =
      tool === 'submit_request' || tool === 'create_request'
        ? `Logged as ${data.id}.`
        : tool === 'queue_request'
          ? 'Queued.'
          : tool === 'start_request'
            ? 'Started.'
            : undefined
    return renderRequest(data, { admin, banner })
  }
  draw(`<div class="card"><pre class="small" style="white-space:pre-wrap;margin:0">${esc(JSON.stringify(data, null, 2))}</pre></div>`)
}

let lastData: unknown

app.ontoolinputpartial = (params) => {
  if (toolName() !== 'draft_request') return
  streaming = true
  renderDraft((params.arguments ?? {}) as Draft, { streaming: true })
}

app.ontoolinput = (params) => {
  if (toolName() !== 'draft_request') return
  renderDraft((params.arguments ?? {}) as Draft, { streaming: true })
}

app.ontoolresult = (result) => {
  streaming = false
  if (result.isError) {
    const text = (result.content ?? []).find((c: any) => c.type === 'text') as { text?: string } | undefined
    draw(`<div class="card"><p class="small muted">The desk said</p><p>${esc(text?.text ?? 'Something went wrong.')}</p></div>`)
    return
  }
  lastData = dataOf(result as any)
  redraw = () => route(lastData)
  route(lastData)
  // Only the newest command center stays live; it carries the server's time.
  const at = (lastData as any)?.repliesDue ? Date.parse((lastData as any).at) : NaN
  if (Number.isFinite(at)) supersede('board', at, () => redraw?.())
}

app.ontoolcancelled = () => {
  draw('<div class="card"><p class="muted">Cancelled.</p></div>')
}

app.onhostcontextchanged = (changed) => {
  const modeChanged = changed.displayMode && changed.displayMode !== hostContext().displayMode
  applyContext(changed)
  if (modeChanged && !streaming) redraw?.()
}

app
  .connect()
  .then(() => applyContext(app.getHostContext() ?? {}))
  .catch((e: unknown) => {
    draw(`<div class="card"><p>Could not connect to Claude: ${esc(String(e))}</p></div>`)
  })
