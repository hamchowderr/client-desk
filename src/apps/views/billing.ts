/**
 * A retainer's billing: the plan, the next charge, paused months and payments.
 * Clients see their own; Chowderr also sees what each Stripe event did.
 */
import { call, day, draw, esc, monthName, money, on, pill, say } from '../kit'

export type Billing = {
  client: { code: string; name: string }
  retainer: {
    status: string
    monthlyRate: { cents: number; currency: string }
    activeLimit: number
    startedAt: string
    nextChargeAt: string | null
    endsAt: string | null
    pausedMonths: string[]
  }
  billingRef?: string | null
  nextChargeAt: string | null
  payments: Array<{ invoice: string | null; amount: { cents: number; currency: string | null } | null; paidAt: string | null; outcome?: string }>
}

const statusPill = (s: string) =>
  s === 'active'
    ? pill('Active', 'ok')
    : s === 'paused'
      ? pill('Paused this month', 'warn')
      : s === 'cancelling'
        ? pill('Ending', 'bad')
        : s === 'onboarding'
          ? pill('Starting up', 'info')
          : pill(s)

const outcomeText = (o: string) =>
  o.startsWith('next charge')
    ? `Paid the charge; next one ${day(`${o.slice('next charge '.length)}T12:00:00Z`)}`
    : o === 'recorded'
      ? 'Recorded (paid early)'
      : o === 'unmatched'
        ? 'Not matched to a client'
        : o

export function renderBilling(b: Billing, opts: { admin: boolean }) {
  const r = b.retainer
  const rate = money(r.monthlyRate.cents, r.monthlyRate.currency)
  const next = r.status === 'cancelling' ? r.endsAt : b.nextChargeAt
  const nextPaused = next && r.pausedMonths.length ? r.pausedMonths.includes(String(next).slice(0, 7)) : false

  draw(`<div class="card appear">
    <div class="spread">
      <div class="grow"><div class="eyebrow">${opts.admin ? `Billing · ${esc(b.client.name)}` : 'Your plan'}</div><h1>${esc(rate)} a month</h1></div>
      ${statusPill(r.status)}
    </div>
    <div class="tiles" style="margin-top:12px">
      <div class="tile"><div class="small muted">${r.status === 'cancelling' ? 'Ends' : 'Next charge'}</div><div class="n" style="font-size:18px">${esc(
        day(next) || '—',
      )}</div>${nextPaused ? '<div class="small muted">Paused, so it’s skipped</div>' : ''}</div>
      <div class="tile"><div class="small muted">At once</div><div class="n" style="font-size:18px">${r.activeLimit} request${r.activeLimit === 1 ? '' : 's'}</div></div>
      <div class="tile"><div class="small muted">Member since</div><div class="n" style="font-size:18px">${esc(day(r.startedAt))}</div></div>
    </div>
    ${
      r.pausedMonths.length
        ? `<div class="soft small" style="margin-top:12px">Paused: ${r.pausedMonths.map((m) => esc(monthName(m, true))).join(', ')}. Those charges are skipped.</div>`
        : ''
    }
    <h3 style="margin-top:16px">Payments</h3>
    <div class="list" style="margin-top:4px">${
      b.payments.length
        ? b.payments
            .map(
              (p) => `<div class="item"><div class="grow"><div class="t">${esc(day(p.paidAt) || 'Date unknown')}</div>${
                opts.admin && p.outcome ? `<div class="small muted">${esc(outcomeText(p.outcome))}</div>` : ''
              }</div><span class="clock">${p.amount ? esc(money(p.amount.cents, p.amount.currency ?? 'usd')) : '—'}</span></div>`,
            )
            .join('')
        : `<p class="small muted" style="padding:8px 0">${opts.admin ? 'No Stripe payments seen yet.' : 'No payments on record here yet.'}</p>`
    }</div>
    ${opts.admin && b.billingRef ? `<p class="small muted" style="margin-top:8px">Stripe: <span class="rid">${esc(b.billingRef)}</span></p>` : ''}
    <div class="actions">
      ${
        opts.admin
          ? ''
          : `<button data-act="pause">Pause a month</button><button class="ghost" data-act="question">Ask about billing</button>`
      }
      <button class="ghost" data-act="refresh">Refresh</button>
    </div>
  </div>`)

  on(
    {
      pause: () => say('I’d like to pause a month.'),
      question: () => say('I have a question about my billing.'),
      refresh: async () =>
        renderBilling(await call<Billing>(opts.admin ? 'billing_history' : 'my_billing', opts.admin ? { client: b.client.code } : {}), opts),
    },
    () => renderBilling(b, opts),
  )
}
