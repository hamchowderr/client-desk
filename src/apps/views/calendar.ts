/** The desk calendar: one month of dates, tap a day to see what's on it, and what's coming up. */
import { call, dayTime, draw, esc, forText, monthName, on, timeZone } from '../kit'

type Event = {
  at: string
  kind: 'received' | 'reply_due' | 'started' | 'delivered' | 'charge' | 'paused' | 'ends'
  title: string
  client: { code: string; name: string }
  request?: string
  for?: string | null
}

type Calendar = {
  calendar: string
  client: { code: string; name: string } | null
  today: string
  events: Event[]
  upcoming: Event[]
}

const KIND: Record<Event['kind'], string> = {
  received: 'Request in',
  reply_due: 'Reply due',
  started: 'Work starts',
  delivered: 'Delivered',
  charge: 'Charge',
  paused: 'Paused month',
  ends: 'Retainer ends',
}

/** YYYY-MM-DD in the viewer's time zone. */
const dayKey = (iso: string | Date) => new Date(iso).toLocaleDateString('en-CA', { timeZone: timeZone() })

let picked: string | null = null

function row(e: Event, admin: boolean) {
  const who = admin ? ` · ${esc(e.client.name)}` : ''
  return `<div class="row" style="align-items:flex-start;gap:10px;padding:8px 0;border-top:var(--hair) solid var(--line2)">
    <span class="pill k-${e.kind}" style="flex:none"><span class="dot"></span>${esc(KIND[e.kind])}</span>
    <div class="grow"><div>${e.request ? `<span class="rid">${esc(e.request)}</span> ` : ''}${esc(e.title)}</div>
    <div class="small muted">${esc(dayTime(e.at))}${who}${e.for === e.client.name ? '' : forText(e.for)}</div></div>
  </div>`
}

export function renderCalendar(data: Calendar, opts: { tool: 'calendar' | 'my_calendar' }) {
  const admin = opts.tool === 'calendar'
  const [y, m] = data.calendar.split('-').map(Number) as [number, number]
  const first = new Date(Date.UTC(y, m - 1, 1))
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lead = first.getUTCDay()
  const today = dayKey(data.today)
  const byDay = new Map<string, Event[]>()
  for (const e of data.events) {
    const k = dayKey(e.at)
    byDay.set(k, [...(byDay.get(k) ?? []), e])
  }
  if (picked && !picked.startsWith(data.calendar)) picked = null

  const cells = [
    ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="wd" aria-hidden="true">${d}</div>`),
    ...Array.from({ length: lead }, () => '<div class="d out"></div>'),
    ...Array.from({ length: days }, (_, i) => {
      const k = `${data.calendar}-${String(i + 1).padStart(2, '0')}`
      const evs = byDay.get(k) ?? []
      const cls = [k === today ? 'today' : '', k === picked ? 'picked' : ''].join(' ')
      const label = `${monthName(data.calendar, true)} ${i + 1}: ${evs.length ? evs.map((e) => KIND[e.kind]).join(', ') : 'nothing'}`
      return `<button class="d ${cls}" data-act="day" data-day="${k}" aria-label="${esc(label)}" aria-pressed="${k === picked}">
        <span class="n">${i + 1}</span><span class="marks">${evs
          .slice(0, 6)
          .map((e) => `<i class="k-${e.kind}"></i>`)
          .join('')}</span></button>`
    }),
  ].join('')

  const pickedEvents = picked ? byDay.get(picked) ?? [] : []
  const kinds = [...new Set(data.events.map((e) => e.kind))]
  const title = data.client ? (admin ? `${data.client.name}'s calendar` : 'Your calendar') : 'Desk calendar'

  draw(`<div class="card appear">
    <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
      <div><div class="eyebrow">${esc(title)}</div><h1>${esc(monthName(data.calendar, true))} ${y}</h1></div>
      <div class="row" style="gap:6px">
        <button class="icon" data-act="go" data-by="-1" aria-label="Previous month">‹</button>
        <button data-act="go" data-by="0">Today</button>
        <button class="icon" data-act="go" data-by="1" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="cal" role="group" aria-label="Days of ${esc(monthName(data.calendar, true))}">${cells}</div>
    ${kinds.length ? `<div class="legend">${kinds.map((k) => `<span><i class="k-${k}"></i>${esc(KIND[k])}</span>`).join('')}</div>` : '<p class="small muted" style="margin-top:10px">Nothing on the calendar this month.</p>'}
    ${
      picked
        ? `<div class="appear" style="margin-top:12px"><h3>${esc(new Date(`${picked}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }))}</h3>${
            pickedEvents.length ? pickedEvents.map((e) => row(e, admin)).join('') : '<p class="small muted">Nothing that day.</p>'
          }</div>`
        : ''
    }
    <div style="margin-top:14px"><h3>Coming up</h3>${
      data.upcoming.length
        ? data.upcoming.map((e) => row(e, admin)).join('')
        : '<p class="small muted">Nothing in the next two weeks.</p>'
    }</div>
  </div>`)

  const shift = (ym: string, by: number) => {
    const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + by, 1))
    return d.toISOString().slice(0, 7)
  }
  on(
    {
      day: (el) => {
        picked = picked === el.dataset.day ? null : el.dataset.day!
        renderCalendar(data, opts)
      },
      go: async (el) => {
        const by = Number(el.dataset.by)
        const month = by === 0 ? dayKey(data.today).slice(0, 7) : shift(data.calendar, by)
        const args: Record<string, unknown> = { month }
        if (admin && data.client) args.client = data.client.code
        picked = null
        renderCalendar(await call<Calendar>(opts.tool, args), opts)
      },
    },
    () => renderCalendar(data, opts),
  )
}
