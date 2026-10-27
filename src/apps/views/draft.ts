/**
 * A request being drafted. The card fills in as Claude writes it (streamed
 * tool input), and the client sends it themselves with Submit. Once sent it
 * becomes the request's tracker.
 */
import { call, dayTime, draw, esc, hostContext, icons, on, say, tell, typeLabel } from '../kit'
import { type Req, renderRequest } from './request'

export type Draft = {
  title?: string
  type?: string
  trigger?: string
  result?: string
  systems?: string
  currentWay?: string
  links?: string
  for?: string
  submittedBy?: string
}
type DraftResult = { draft: Draft; replyByIfSentNow?: string; missing?: string[]; client?: { name: string } }

const sentKey = () => `client-desk:sent:${hostContext().toolInfo?.id ?? ''}`

function remembered(): string | null {
  try {
    return hostContext().toolInfo?.id ? localStorage.getItem(sentKey()) : null
  } catch {
    return null
  }
}

function remember(id: string) {
  try {
    if (hostContext().toolInfo?.id) localStorage.setItem(sentKey(), id)
  } catch {
    // Storage can be off; the card just won't remember after a reload.
  }
}

const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** Which field the text is still arriving in, so it gets the typing caret. */
function lastField(d: Draft): keyof Draft | null {
  for (const k of ['submittedBy', 'for', 'links', 'currentWay', 'systems', 'result', 'trigger', 'type', 'title'] as const) if (d[k]) return k
  return null
}

/** The four things every request needs before it can be sent, as the card asks for them. */
const ASK = {
  trigger: 'what starts it',
  result: 'what you get back',
  systems: 'which tools or accounts it touches',
  currentWay: "how it's done today",
  for: "who it's for",
} as const

const detail = (label: string, body: string, isMissing: boolean) =>
  `<div class="box ${isMissing ? 'missing' : ''}"><div class="eyebrow">${esc(label)}</div><div>${body}</div></div>`

export function renderDraft(d: Draft, opts: { streaming: boolean; result?: DraftResult }) {
  const typing = opts.streaming ? lastField(d) : null
  const text = (k: keyof Draft, empty: string) =>
    d[k] ? `<span class="${typing === k ? 'caret' : ''}">${esc(d[k])}</span>` : `<span class="muted">${esc(empty)}</span>`
  const missing: string[] =
    opts.result?.missing ?? (Object.keys(ASK) as Array<keyof typeof ASK>).filter((k) => !d[k]?.trim())
  const ready = !opts.streaming && !!opts.result && missing.length === 0 && !!d.title

  draw(`<div class="card appear">
    <div class="spread">
      <span class="eyebrow">New request${opts.result?.client ? ` for ${esc(opts.result.client.name)}` : ''}</span>
      ${d.type ? `<span class="pill info">${esc(typeLabel[d.type] ?? d.type)}</span>` : ''}
    </div>
    <h1 style="margin-top:6px">${d.title ? text('title', '') : '<span class="skel" style="display:block;height:24px;width:60%"></span>'}</h1>
    <p class="small ${d.for ? '' : 'muted'}" style="margin-top:4px">For ${d.for ? text('for', '') : opts.streaming ? '…' : '<span class="muted">(Claude will ask who this is for)</span>'}</p>
    <div class="flow">
      <div class="box ${d.trigger ? '' : 'missing'}"><div class="eyebrow">When this happens</div><div>${text(
        'trigger',
        opts.streaming ? '…' : 'Claude will ask you',
      )}</div></div>
      <div class="arrow">${icons.arrow}</div>
      <div class="box ${d.result ? '' : 'missing'}"><div class="eyebrow">You get</div><div>${text(
        'result',
        opts.streaming ? '…' : 'Claude will ask you',
      )}</div></div>
    </div>
    <div class="pair">
      ${detail('Tools and accounts', text('systems', opts.streaming ? '…' : 'Claude will ask you'), !d.systems)}
      ${detail('How it works today', text('currentWay', opts.streaming ? '…' : 'Claude will ask you'), !d.currentWay)}
    </div>
    ${d.links ? `<div style="margin-top:8px">${detail('Links and examples', text('links', ''), false)}</div>` : ''}
    ${
      ready
        ? `<p class="small muted" style="margin-top:12px">Send it now for a reply by ${esc(
            dayTime(opts.result!.replyByIfSentNow),
          )}. Chowderr confirms the scope and size before it's queued.</p>`
        : !opts.streaming && missing.length
          ? `<p class="small muted" style="margin-top:12px">Almost there. Tell Claude ${esc(
              joinAnd(missing.map((k) => ASK[k as keyof typeof ASK] ?? k)),
            )}.</p>`
          : ''
    }
    <div class="actions">
      <button class="primary" data-act="submit" ${ready ? '' : 'disabled'}>Submit request</button>
      <button data-act="change" ${opts.streaming ? 'disabled' : ''}>Change something</button>
    </div>
  </div>`)

  on(
    {
      submit: async () => {
        const created = await call<Req>('submit_request', { ...d, source: 'claude' })
        remember(created.id)
        tell(
          `The client pressed Submit on the draft card. It's logged as ${created.id} ("${created.title}") and is now with Chowderr. Don't submit it again.`,
        )
        renderRequest(created, { admin: false, banner: `Sent. It's ${created.id}.` })
      },
      change: () => say('I want to change something on this request before I send it.'),
    },
    () => renderDraft(d, opts),
  )
}

/** A draft that was already sent shows its live tracker instead. */
export async function renderDraftResult(result: DraftResult) {
  const sent = remembered()
  if (sent) {
    try {
      renderRequest(await call<Req>('get_my_request', { request: sent }), { admin: false })
      return
    } catch {
      // Fall back to the draft.
    }
  }
  renderDraft(result.draft, { streaming: false, result })
}
