/** One request: its stages, what starts it and what comes back, its story, and what can be done next. */
import {
  call,
  dayTime,
  draw,
  esc,
  fromNow,
  icons,
  on,
  openLink,
  pill,
  progress,
  say,
  stages,
  statusLabel,
  statusTone,
  tell,
  typeLabel,
} from '../kit'

export type Req = {
  id: string
  title: string
  type: string | null
  trigger: string | null
  result: string | null
  status: string
  sizeDays: number | null
  needsCall?: boolean
  receivedAt?: string
  replyDueAt?: string | null
  firstResponseAt?: string | null
  startedAt?: string | null
  deliveredAt?: string | null
  deliverableUrl?: string | null
  client?: string
  timeline?: Array<{ at: string; author: string; kind: string; body: string; visibility?: string }>
}

let showAll = false

const who = (author: string, admin: boolean) => {
  if (author === 'owner' || (author.startsWith('agent:') && author.includes('@'))) return 'Chowderr'
  if (author.startsWith('contact:') || author.startsWith('client-agent:')) return admin ? 'Client' : 'Your team'
  return 'Assistant'
}

function timeline(r: Req, admin: boolean) {
  const events = r.timeline ?? []
  if (!events.length) return ''
  const shown = showAll ? events : events.slice(-3)
  return `<div class="tl">${shown
    .map(
      (e) => `<div class="ev ${esc(e.kind)}">
        <div class="small muted">${esc(who(e.author, admin))} · ${esc(dayTime(e.at))}${
          admin && e.visibility === 'internal' ? ' · <span class="pill">Only you</span>' : ''
        }</div>
        <div class="body">${esc(e.body)}</div>
      </div>`,
    )
    .join('')}</div>${
    events.length > 3
      ? `<button class="ghost small" data-act="toggle-tl">${showAll ? 'Show less' : `Show all ${events.length} updates`}</button>`
      : ''
  }`
}

const scoped = (r: Req) => !!(r.type && r.trigger && r.result && r.sizeDays)

const approved = (r: Req) =>
  (r.timeline ?? []).some((e) => e.kind === 'client_message' && e.body === APPROVAL && (!r.deliveredAt || e.at >= r.deliveredAt))
const APPROVAL = 'Looks good, approved.'

function clientActions(r: Req) {
  if (r.status === 'in_review') {
    return approved(r)
      ? []
      : [`<button class="primary" data-act="approve">Looks good</button>`, `<button data-act="changes">Ask for changes</button>`]
  }
  if (r.status === 'waiting_on_client') return [`<button class="primary" data-act="answer">Answer the question</button>`]
  if (r.status !== 'done' && r.status !== 'declined') return [`<button data-act="detail">Add a detail</button>`]
  return []
}

function adminActions(r: Req) {
  const out: string[] = []
  if (r.status === 'new' || r.status === 'scoping' || r.status === 'waiting_on_client') {
    if (scoped(r)) out.push(`<button class="primary" data-act="queue">Queue it</button>`)
    else out.push(`<button class="primary" data-act="scope">Scope it</button>`)
  }
  if (r.status === 'queued') out.push(`<button class="primary" data-act="start">Start now</button>`)
  if (r.status === 'active') {
    out.push(`<button class="primary" data-act="deliver">Deliver</button>`)
    out.push(`<button data-act="ask">Ask the client</button>`)
  }
  if (r.status === 'in_review') out.push(`<button class="primary" data-act="close">Mark done</button>`)
  if (out.length < 2) out.push(`<button data-act="note">Add a note</button>`)
  return out.slice(0, 2)
}

export function renderRequest(r: Req, opts: { admin: boolean; banner?: string }) {
  const { admin } = opts
  const replyOwed = r.replyDueAt && !r.firstResponseAt && r.status !== 'done' && r.status !== 'declined'
  const facts = [
    r.type ? typeLabel[r.type] ?? r.type : null,
    r.sizeDays ? `${r.sizeDays} day${r.sizeDays === 1 ? '' : 's'}` : null,
    r.needsCall ? 'Needs a call' : null,
  ].filter(Boolean)

  draw(`<div class="card appear">
    ${opts.banner ? `<div class="toast ok" style="margin:0 0 12px">${esc(opts.banner)}</div>` : ''}
    <div class="spread">
      <span class="rid">${esc(r.id)}${admin && r.client ? ` · ${esc(r.client)}` : ''}</span>
      ${pill(admin && r.status === 'waiting_on_client' ? 'Waiting on client' : statusLabel[r.status] ?? r.status, statusTone[r.status])}
    </div>
    <h1 style="margin-top:6px">${esc(r.title)}</h1>
    ${facts.length ? `<p class="small muted" style="margin-top:4px">${facts.map(esc).join(' · ')}</p>` : ''}
    ${stages(r.status)}
    ${r.status === 'active' ? progress(r.startedAt ?? null, r.sizeDays) : ''}
    <div class="flow">
      <div class="box ${r.trigger ? '' : 'missing'}"><div class="eyebrow">When this happens</div><div>${
        r.trigger ? esc(r.trigger) : '<span class="muted">Not set yet</span>'
      }</div></div>
      <div class="arrow">${icons.arrow}</div>
      <div class="box ${r.result ? '' : 'missing'}"><div class="eyebrow">${admin ? 'They get' : 'You get'}</div><div>${
        r.result ? esc(r.result) : '<span class="muted">Not set yet</span>'
      }</div></div>
    </div>
    ${
      replyOwed
        ? `<p class="small" style="margin-top:12px">${
            admin ? `Your reply is due ${esc(fromNow(r.replyDueAt!))}` : `Chowderr replies by ${esc(dayTime(r.replyDueAt!))}`
          }</p>`
        : ''
    }
    ${
      r.deliverableUrl
        ? `<button class="soft row" style="width:100%;margin-top:12px;justify-content:space-between;border:0;text-align:left;padding:10px 12px" data-act="open-deliverable"><span><span class="eyebrow">Delivered${
            r.deliveredAt ? ` ${esc(dayTime(r.deliveredAt))}` : ''
          }</span><br>Open the delivered work</span>${icons.arrow}</button>`
        : ''
    }
    ${!admin && r.status === 'in_review' && approved(r) ? `<p class="small" style="margin-top:12px;color:var(--ok)">You approved it. Chowderr will close it out.</p>` : ''}
    ${timeline(r, admin)}
    ${(() => {
      const acts = admin ? adminActions(r) : clientActions(r)
      return acts.length ? `<div class="actions">${acts.join('')}</div>` : ''
    })()}
  </div>`)

  const refresh = async (banner?: string) => {
    const fresh = await call<Req>(admin ? 'get_request' : 'get_my_request', { request: r.id })
    renderRequest(fresh, { admin, banner })
  }
  const adminDo = async (tool: string, done: string) => {
    await call(tool, { request: r.id })
    tell(`On the ${r.id} card, Chowderr pressed a button: ${done}.`)
    await refresh(done)
  }

  on(
    {
      'toggle-tl': () => {
        showAll = !showAll
        renderRequest(r, opts)
      },
      'open-deliverable': () => openLink(r.deliverableUrl!),
      approve: async () => {
        await call('add_message', { request: r.id, body: APPROVAL })
        tell(`The client approved ${r.id} from its card ("Looks good").`)
        await refresh()
      },
      changes: () => say(`I'd like to ask for changes to ${r.id}.`),
      answer: () => say(`I want to answer the question on ${r.id}.`),
      detail: () => say(`I want to add a detail to ${r.id}.`),
      scope: () => say(`Let's scope ${r.id}.`),
      queue: () => adminDo('queue_request', 'Queued'),
      start: () => adminDo('start_request', 'Started'),
      deliver: () => say(`${r.id} is ready to deliver.`),
      ask: () => say(`I need to ask the client something about ${r.id}.`),
      close: () => adminDo('close_request', 'Marked done'),
      note: () => say(`Add a note to ${r.id}.`),
    },
    () => renderRequest(r, opts),
  )
}
