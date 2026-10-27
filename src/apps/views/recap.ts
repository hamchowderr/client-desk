/**
 * A client's week: delivered, in progress, waiting on them, up next. Chowderr
 * can email it to the client from here.
 */
import { call, day, draw, esc, forText, on, progress, say, tell } from '../kit'

type Item = { id: string; title: string; for?: string | null; status: string; sizeDays: number | null; startedAt: string | null; deliveredAt: string | null; deliverableUrl: string | null }
export type Recap = {
  client: { code: string; name: string }
  from: string
  to: string
  headline: string
  shipped: Item[]
  inProgress: Item[]
  waitingOnYou: Item[]
  upNext: Item[]
  moreQueued: number
  received: number
}

let sentTo: string[] | null = null

function block(title: string, items: Item[], body: (i: Item) => string, tone = '') {
  if (!items.length) return ''
  return `<section style="margin-top:14px"><div class="eyebrow" ${tone ? `style="color:var(--${tone})"` : ''}>${esc(title)}</div><div class="list">${items
    .map(
      (i) => `<div class="item"><div class="grow"><div class="t">${esc(i.title)}</div><div class="small muted"><span class="rid">${esc(i.id)}</span>${forText(i.for)}${body(i)}</div>${
        i.status === 'active' ? progress(i.startedAt, i.sizeDays) : ''
      }</div><button class="ghost small" data-act="show" data-id="${esc(i.id)}">Open</button></div>`,
    )
    .join('')}</div></section>`
}

export function renderRecap(r: Recap, opts: { admin: boolean }) {
  const quiet = !r.shipped.length && !r.inProgress.length && !r.waitingOnYou.length && !r.upNext.length
  const them = opts.admin ? 'them' : 'you'
  const headline =
    [
      r.shipped.length && `${r.shipped.length} delivered`,
      r.inProgress.length && `${r.inProgress.length} in progress`,
      r.waitingOnYou.length && `${r.waitingOnYou.length} waiting on ${them}`,
    ]
      .filter(Boolean)
      .join(', ') || 'all quiet'
  draw(`<div class="card appear">
    <div class="eyebrow">${opts.admin ? `${esc(r.client.name)} · ` : ''}${esc(day(r.from))} to ${esc(day(r.to))}</div>
    <h1 style="margin-top:2px">${opts.admin ? 'Their week' : 'Your week'}: ${esc(headline)}</h1>
    <div class="tiles" style="margin-top:12px">
      <div class="tile"><div class="n">${r.shipped.length}</div><div class="small muted">delivered</div></div>
      <div class="tile"><div class="n">${r.inProgress.length}</div><div class="small muted">in progress</div></div>
      <div class="tile ${r.waitingOnYou.length ? 'alert' : ''}"><div class="n">${r.waitingOnYou.length}</div><div class="small muted">waiting on ${them}</div></div>
      <div class="tile"><div class="n">${r.received}</div><div class="small muted">new requests</div></div>
    </div>
    ${block('Delivered', r.shipped, (i) => (i.deliveredAt ? ` · ${esc(day(i.deliveredAt))}` : '') + (i.status === 'in_review' ? ' · ready for review' : ''))}
    ${block(`Waiting on ${them}`, r.waitingOnYou, () => '', 'warn')}
    ${block('In progress', r.inProgress, () => '')}
    ${block('Up next', r.upNext, () => '')}
    ${r.moreQueued ? `<p class="small muted" style="margin-top:6px">Then ${r.moreQueued} more in the queue.</p>` : ''}
    ${quiet ? `<p class="muted" style="margin-top:12px">Nothing open this week.</p>` : ''}
    ${sentTo ? `<div class="toast ok" style="margin:12px 0 0">Sent to ${esc(sentTo.join(', '))}.</div>` : ''}
    <div class="actions">
      ${
        opts.admin
          ? `<button class="primary" data-act="send" ${sentTo ? 'disabled' : ''}>${sentTo ? 'Sent' : `Email this to ${esc(r.client.name)}`}</button>`
          : '<button class="primary" data-act="new">New request</button>'
      }
    </div>
  </div>`)

  on(
    {
      show: (el) => say(`Show me ${el.dataset.id}.`),
      new: () => say('I’d like to make a new request.'),
      send: async () => {
        const res = await call<{ sentTo: string[] }>('send_recap', { client: r.client.code })
        sentTo = res.sentTo
        tell(
          res.sentTo.length
            ? `Chowderr emailed ${r.client.name}'s weekly recap to ${res.sentTo.join(', ')} from the recap screen. Don't send it again.`
            : `Chowderr pressed send on ${r.client.name}'s recap, but they have no contact with an email.`,
        )
        renderRecap(r, opts)
      },
    },
    () => renderRecap(r, opts),
  )
}
