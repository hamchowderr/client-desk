/**
 * Chowderr's command center: reply deadlines that warm up as they close in,
 * capacity, and every client's lanes with one-press Start, Mark done and queue
 * reordering. Inline it's the urgent part; full screen is the whole desk.
 */
import {
  call,
  canFullscreen,
  draw,
  esc,
  fromNow,
  fullscreenButton,
  heat,
  icons,
  isFullscreen,
  on,
  pill,
  progress,
  say,
  tell,
  toggleFullscreen,
  typeLabel,
} from '../kit'

type Item = { id: string; title: string; type: string | null; sizeDays: number | null; startedAt?: string | null }
export type Board = {
  at: string
  repliesDue: Array<{ id: string; client: string; title: string; dueAt: string; overdue: boolean }>
  counts: { overdueReplies: number; repliesDueToday: number; active: number; queued: number; waitingOnClients: number }
  spots: { taken: number; capacity: number }
  clients: Array<{
    code: string
    name: string
    retainer: { status: string; activeLimit: number; nextChargeAt: string | null }
    active: Item[]
    queued: Item[]
    intake: Item[]
    inReview: Item[]
    waitingOnClient: Item[]
  }>
}

let tick: ReturnType<typeof setInterval> | undefined

const seg = (on: number, of: number) =>
  `<div class="seg" role="img" aria-label="${on} of ${of}">${Array.from({ length: Math.max(of, 1) }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>`

function replies(b: Board, limit: number) {
  if (!b.repliesDue.length) return `<div class="soft small" style="margin-top:12px">${pill('All caught up', 'ok')} No replies owed.</div>`
  return `<div class="list" style="margin-top:8px">${b.repliesDue
    .slice(0, limit)
    .map((r) => {
      const h = heat(r.dueAt)
      return `<div class="item">
        <div class="grow"><div class="t">${esc(r.title)}</div><div class="small muted"><span class="rid">${esc(r.id)}</span> · ${esc(r.client)}</div></div>
        <span class="small clock heat-${h}">${r.overdue ? 'overdue ' : ''}${esc(fromNow(r.dueAt))}</span>
        <button data-act="reply" data-id="${esc(r.id)}">Reply</button>
      </div>`
    })
    .join('')}</div>${
    b.repliesDue.length > limit ? `<p class="small muted" style="margin-top:6px">And ${b.repliesDue.length - limit} more.</p>` : ''
  }`
}

function row(i: Item, actions: string, n?: number) {
  const meta = [i.type ? typeLabel[i.type] : null, i.sizeDays ? `${i.sizeDays}d` : null].filter(Boolean).join(' · ')
  return `<div class="item">
    ${n ? `<span class="num">${n}</span>` : ''}
    <div class="grow"><div class="t">${esc(i.title)}</div><div class="small muted"><span class="rid">${esc(i.id)}</span>${
      meta ? ` · ${esc(meta)}` : ''
    }</div>${i.startedAt ? progress(i.startedAt, i.sizeDays) : ''}</div>
    <div class="row">${actions}</div>
  </div>`
}

function client(c: Board['clients'][number]) {
  const lane = (title: string, items: Item[], act: (i: Item, n: number) => string, numbered = false) =>
    items.length
      ? `<div style="margin-top:10px"><div class="eyebrow">${esc(title)}</div><div class="list">${items
          .map((i, n) => row(i, act(i, n), numbered ? n + 1 : undefined))
          .join('')}</div></div>`
      : ''
  const free = c.retainer.activeLimit - c.active.length
  const empty = !c.active.length && !c.queued.length && !c.intake.length && !c.inReview.length && !c.waitingOnClient.length
  return `<section class="card">
    <div class="spread"><h2>${esc(c.name)}</h2>${
      c.retainer.status === 'active' ? pill('Active', 'ok') : c.retainer.status === 'paused' ? pill('Paused', 'warn') : pill(c.retainer.status, 'bad')
    }</div>
    <div class="row small muted" style="margin-top:8px"><div class="grow">${seg(c.active.length, c.retainer.activeLimit)}</div><span>${c.active.length}/${
      c.retainer.activeLimit
    } active</span></div>
    ${lane('Just received', c.intake, (i) => `<button class="small" data-act="scope" data-id="${esc(i.id)}">Scope</button>`)}
    ${lane('Waiting on them', c.waitingOnClient, () => '')}
    ${lane('In progress', c.active, (i) => `<button class="small" data-act="deliver" data-id="${esc(i.id)}">Deliver</button>`)}
    ${lane('In review', c.inReview, (i) => `<button class="small" data-act="close" data-id="${esc(i.id)}">Mark done</button>`)}
    ${lane(
      'Queue',
      c.queued,
      (i, n) =>
        `<button class="icon ghost" data-act="up" data-client="${esc(c.code)}" data-id="${esc(i.id)}" ${n === 0 ? 'disabled' : ''} aria-label="Move up">${
          icons.up
        }</button><button class="icon ghost" data-act="down" data-client="${esc(c.code)}" data-id="${esc(i.id)}" ${
          n === c.queued.length - 1 ? 'disabled' : ''
        } aria-label="Move down">${icons.down}</button>`,
      true,
    )}
    ${empty ? '<p class="small muted" style="margin-top:10px">Nothing open.</p>' : ''}
    ${
      c.queued.length && free > 0
        ? `<div class="actions"><button class="primary" data-act="start-next" data-client="${esc(c.code)}">Start next ${
            free > 1 ? `${Math.min(free, c.queued.length)}` : ''
          }</button></div>`
        : ''
    }
  </section>`
}

export function renderCommand(b: Board) {
  const full = isFullscreen()
  const tiles = `<div class="tiles" style="margin-top:12px">
    <div class="tile ${b.counts.overdueReplies ? 'alert' : ''}"><div class="n">${b.counts.overdueReplies}</div><div class="small muted">replies overdue</div></div>
    <div class="tile"><div class="n">${b.counts.repliesDueToday}</div><div class="small muted">due today</div></div>
    <div class="tile"><div class="n">${b.counts.active}</div><div class="small muted">in progress</div></div>
    <div class="tile"><div class="n">${b.counts.queued}</div><div class="small muted">queued</div></div>
    <div class="tile"><div class="n">${b.counts.waitingOnClients}</div><div class="small muted">waiting on clients</div></div>
  </div>
  <div class="row small muted" style="margin-top:12px"><span>Retainer spots</span><div class="grow">${seg(b.spots.taken, b.spots.capacity)}</div><span>${
    b.spots.taken
  } of ${b.spots.capacity}</span></div>`

  const head = `<div class="spread">
    <div><div class="eyebrow">Client Desk</div><h1>${b.counts.overdueReplies ? `${b.counts.overdueReplies} overdue` : b.repliesDue.length ? `${b.repliesDue.length} to reply to` : 'All caught up'}</h1></div>
    <div class="row"><span class="small muted clock">Updated ${esc(fromNow(b.at))}</span><button class="icon ghost" data-act="refresh" aria-label="Refresh" title="Refresh">${
      icons.refresh
    }</button>${fullscreenButton()}</div>
  </div>`

  if (!full) {
    draw(`<div class="card appear">${head}${replies(b, 3)}${tiles}
      <div class="actions">${canFullscreen() ? '<button class="primary" data-act="fullscreen">Open the command center</button>' : ''}</div>
    </div>${canFullscreen() ? '' : `<div class="lanes" style="margin-top:12px">${b.clients.map(client).join('')}</div>`}`)
  } else {
    draw(`<div class="stack appear">
      <div class="card">${head}${replies(b, 50)}${tiles}</div>
      <div class="lanes${b.clients.length === 1 ? ' one' : ''}">${b.clients.map(client).join('')}</div>
    </div>`)
  }

  const refresh = async () => renderCommand(await call<Board>('show_board'))
  const queueOf = (code: string) => b.clients.find((c) => c.code === code)!.queued.map((i) => i.id)
  const move = async (el: HTMLElement, by: number) => {
    const order = queueOf(el.dataset.client!)
    const i = order.indexOf(el.dataset.id!)
    order.splice(i + by, 0, ...order.splice(i, 1))
    await call('reorder_queue', { client: el.dataset.client, order })
    tell(`On the command center, Chowderr reordered ${el.dataset.client}'s queue to: ${order.join(', ')}.`)
    await refresh()
  }
  on(
    {
      refresh,
      reply: (el) => say(`Let's reply to ${el.dataset.id}.`),
      scope: (el) => say(`Let's scope ${el.dataset.id}.`),
      deliver: (el) => say(`${el.dataset.id} is ready to deliver.`),
      close: async (el) => {
        await call('close_request', { request: el.dataset.id })
        tell(`On the command center, Chowderr marked ${el.dataset.id} done.`)
        await refresh()
      },
      'start-next': async (el) => {
        const res = await call<{ started?: Array<{ id: string }> } | Array<{ id: string }>>('start_next', { client: el.dataset.client })
        const started = (Array.isArray(res) ? res : res?.started ?? []).map((r) => r.id)
        tell(`On the command center, Chowderr started the next work for ${el.dataset.client}${started.length ? `: ${started.join(', ')}` : ''}.`)
        await refresh()
      },
      up: (el) => move(el, -1),
      down: (el) => move(el, 1),
      fullscreen: async () => {
        await toggleFullscreen().catch(() => undefined)
        renderCommand(b)
      },
    },
    () => renderCommand(b),
  )

  // Deadlines count down while the view is open.
  if (tick) clearInterval(tick)
  tick = setInterval(() => {
    if (!document.hidden) renderCommand(b)
  }, 60_000)
}
