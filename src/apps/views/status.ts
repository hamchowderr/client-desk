/**
 * A client's work at a glance: what's waiting on them, what's in progress, what's
 * next in their queue, and their retainer. Inline it's a summary; full screen
 * shows every lane and opens each request in place.
 */
import {
  call,
  canFullscreen,
  day,
  dayTime,
  draw,
  esc,
  fullscreenButton,
  icons,
  isFullscreen,
  monthName,
  on,
  pill,
  progress,
  say,
  statusLabel,
  toggleFullscreen,
  typeLabel,
} from '../kit'
import type { Req } from './request'

type Item = {
  id: string
  title: string
  type: string | null
  status: string
  sizeDays: number | null
  position: number | null
  startedAt: string | null
  deliveredAt: string | null
  replyDueAt: string | null
}
export type Overview = {
  client: { code: string; name: string; company?: string | null; status?: string; notes?: string | null }
  retainer: {
    status: string
    activeLimit: number
    nextChargeAt: string | null
    endsAt: string | null
    pausedMonths: string[]
    kickoffDone: boolean
  } | null
  active: Item[]
  queue: Item[]
  inReview: Item[]
  waitingOnClient: Item[]
  intake: Item[]
}

const opened = new Map<string, Req | 'loading'>()

const retainerPill = (r: Overview['retainer']) =>
  !r
    ? pill('No retainer')
    : r.status === 'active'
      ? pill('Active', 'ok')
      : r.status === 'paused'
        ? pill('Paused this month', 'warn')
        : r.status === 'cancelling'
          ? pill('Ending', 'bad')
          : r.status === 'onboarding'
            ? pill('Waiting on kickoff', 'info')
            : pill(r.status)

function detail(id: string) {
  const r = opened.get(id)
  if (!r) return ''
  if (r === 'loading') return `<div class="skel" style="height:48px;margin:6px 0 4px"></div>`
  const last = r.timeline?.at(-1)
  return `<div class="soft small appear" style="margin:2px 0 8px">
    ${r.trigger ? `<div><span class="muted">When</span> ${esc(r.trigger)}</div>` : ''}
    ${r.result ? `<div><span class="muted">You get</span> ${esc(r.result)}</div>` : ''}
    ${last ? `<div style="margin-top:6px"><span class="muted">Latest, ${esc(day(last.at))}:</span> ${esc(last.body)}</div>` : ''}
  </div>`
}

function item(i: Item, opts: { n?: number; admin: boolean; expandable: boolean }) {
  const meta = [i.type ? typeLabel[i.type] : null, i.sizeDays ? `${i.sizeDays}d` : null].filter(Boolean).join(' · ')
  return `<div class="item">
      ${opts.n ? `<span class="num">${opts.n}</span>` : ''}
      <div class="grow">
        <div class="t">${esc(i.title)}</div>
        <div class="small muted"><span class="rid">${esc(i.id)}</span>${i.status === 'in_review' ? ` · <span style="color:var(--warn)">Ready for review</span>` : ''}${meta ? ` · ${esc(meta)}` : ''}${
          i.replyDueAt ? ` · reply by ${esc(dayTime(i.replyDueAt))}` : ''
        }</div>
        ${i.status === 'active' ? progress(i.startedAt, i.sizeDays) : ''}
      </div>
      ${
        opts.expandable
          ? `<button class="ghost small" data-act="open" data-id="${esc(i.id)}" aria-expanded="${opened.has(i.id)}">${
              opened.has(i.id) ? 'Hide' : 'Details'
            }</button>`
          : `<button class="ghost small" data-act="show" data-id="${esc(i.id)}">Open</button>`
      }
    </div>${detail(i.id)}`
}

function lane(title: string, items: Item[], opts: { admin: boolean; numbered?: boolean; empty?: string }) {
  if (!items.length && !opts.empty) return ''
  const full = isFullscreen()
  return `<section class="card lane">
    <div class="spread"><h3>${esc(title)}</h3><span class="small muted">${items.length || ''}</span></div>
    <div class="list">${
      items.length
        ? items.map((i, n) => item(i, { n: opts.numbered ? n + 1 : undefined, admin: opts.admin, expandable: full })).join('')
        : `<p class="small muted" style="padding:8px 0">${esc(opts.empty!)}</p>`
    }</div>
  </section>`
}

function summary(o: Overview, admin: boolean) {
  const parts = [
    o.waitingOnClient.length && `${o.waitingOnClient.length} waiting on ${admin ? 'them' : 'you'}`,
    o.active.length && `${o.active.length} in progress`,
    o.inReview.length && `${o.inReview.length} ready for review`,
    o.queue.length && `${o.queue.length} in the queue`,
    o.intake.length && `${o.intake.length} just received`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing open right now.'
}

export function renderStatus(o: Overview, opts: { admin: boolean }) {
  const { admin } = opts
  const r = o.retainer
  const full = isFullscreen()
  const you = admin ? 'them' : 'you'
  const header = `<div class="spread">
      <div class="grow"><div class="eyebrow">${admin ? 'Client' : 'Your work with Otaku Solutions'}</div><h1>${esc(o.client.name)}</h1></div>
      <div class="row">${retainerPill(r)}<button class="icon ghost" data-act="refresh" aria-label="Refresh" title="Refresh">${
        icons.refresh
      }</button>${fullscreenButton()}</div>
    </div>
    <p class="muted" style="margin-top:6px">${esc(summary(o, admin))}</p>`

  const retainerFacts = r
    ? `<div class="tiles" style="margin-top:12px">
        <div class="tile"><div class="small muted">${r.status === 'cancelling' ? 'Ends' : 'Next charge'}</div><div class="n" style="font-size:18px">${esc(
          day(r.status === 'cancelling' ? r.endsAt : r.nextChargeAt) || '—',
        )}</div></div>
        <div class="tile"><div class="small muted">At once</div><div class="n" style="font-size:18px">${o.active.length} of ${r.activeLimit}</div></div>
        ${
          r.pausedMonths.length
            ? `<div class="tile"><div class="small muted">Paused</div><div class="n" style="font-size:18px">${r.pausedMonths
                .map((m) => esc(monthName(m)))
                .join(', ')}</div></div>`
            : ''
        }
      </div>`
    : ''

  const waiting = o.waitingOnClient.length
    ? `<div class="callout" style="margin-top:12px">
        <h3>${admin ? 'Waiting on them' : 'Waiting on you'}</h3>
        ${o.waitingOnClient
          .slice(0, full ? 99 : 2)
          .map(
            (i) => `<div class="spread" style="margin-top:8px"><div class="grow"><div class="t">${esc(i.title)}</div><div class="small"><span class="rid">${esc(
              i.id,
            )}</span></div></div>${admin ? '' : `<button class="primary" data-act="answer" data-id="${esc(i.id)}">Answer</button>`}</div>`,
          )
          .join('')}
      </div>`
    : ''

  if (!full) {
    const next = o.queue[0]
    draw(`<div class="card appear">
      ${header}
      ${waiting}
      ${
        o.active.length || o.inReview.length
          ? `<div class="list" style="margin-top:8px">${[...o.inReview, ...o.active]
              .slice(0, 3)
              .map((i) => item({ ...i }, { admin, expandable: false }))
              .join('')}</div>`
          : ''
      }
      ${
        next
          ? `<div class="soft" style="margin-top:10px"><div class="eyebrow">Up next</div><div class="t">${esc(next.title)}</div><div class="small muted"><span class="rid">${esc(
              next.id,
            )}</span>${o.queue.length > 1 ? ` · then ${o.queue.length - 1} more` : ''}</div></div>`
          : ''
      }
      ${retainerFacts}
      <div class="actions">
        ${admin ? '' : '<button class="primary" data-act="new">New request</button>'}
        ${canFullscreen() ? `<button data-act="fullscreen">See everything</button>` : ''}
      </div>
    </div>`)
  } else {
    draw(`<div class="stack appear">
      <div class="card">${header}${retainerFacts}${waiting}
        <div class="actions" style="max-width:420px">
          ${admin ? '' : '<button class="primary" data-act="new">New request</button><button data-act="pause">Pause a month</button>'}
        </div>
      </div>
      <div class="lanes">
        ${lane('In progress', o.active, { admin, empty: `Nothing in progress for ${you} right now.` })}
        ${lane('Ready for review', o.inReview, { admin })}
        ${lane('Up next', o.queue, { admin, numbered: true, empty: 'The queue is empty.' })}
        ${lane('Just received', o.intake, { admin })}
      </div>
    </div>`)
  }

  const refresh = async () => {
    const fresh = await call<Overview>(admin ? 'get_client' : 'my_status', admin ? { client: o.client.code } : {})
    Object.assign(o, fresh)
    renderStatus(o, opts)
  }
  on(
    {
      refresh,
      new: () => say('I’d like to make a new request.'),
      pause: async () => {
        if (isFullscreen()) await toggleFullscreen().catch(() => undefined)
        say('I’d like to pause a month.')
      },
      answer: (el) => say(`I want to answer the question on ${el.dataset.id}.`),
      show: (el) => say(`Show me ${el.dataset.id}.`),
      open: async (el) => {
        const id = el.dataset.id!
        if (opened.has(id)) opened.delete(id)
        else {
          opened.set(id, 'loading')
          renderStatus(o, opts)
          opened.set(id, await call<Req>(admin ? 'get_request' : 'get_my_request', { request: id }))
        }
        renderStatus(o, opts)
      },
    },
    () => renderStatus(o, opts),
  )
}

/** A plain list of requests (my_requests, list_requests). */
export function renderList(items: Array<Req & { client?: string }>, opts: { admin: boolean }) {
  draw(`<div class="card appear">
    <div class="spread"><h2>${items.length} request${items.length === 1 ? '' : 's'}</h2>${fullscreenButton()}</div>
    <div class="list" style="margin-top:6px">${items
      .slice(0, isFullscreen() ? 500 : 8)
      .map(
        (r) => `<div class="item"><div class="grow"><div class="t">${esc(r.title)}</div><div class="small muted"><span class="rid">${esc(
          r.id,
        )}</span>${opts.admin && r.client ? ` · ${esc(r.client)}` : ''} · ${esc(statusLabel[r.status] ?? r.status)}</div></div>
        <button class="ghost small" data-act="show" data-id="${esc(r.id)}">Open</button></div>`,
      )
      .join('')}</div>
    ${!isFullscreen() && items.length > 8 ? `<p class="small muted" style="margin-top:8px">And ${items.length - 8} more.</p>` : ''}
  </div>`)
  on({ show: (el) => say(`Show me ${el.dataset.id}.`) }, () => renderList(items, opts))
}
