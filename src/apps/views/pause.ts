/** The pause calendar: the next six billing months, tap one, confirm, done. */
import { call, day, draw, esc, monthName, on, tell } from '../kit'

type Plan = {
  retainer: { status: string; nextChargeAt: string | null; pausedMonths: string[] }
  maxInARow: number
  months: Array<{ month: string; chargeOn: string; paused: boolean; canPause: boolean; blockedBecause: string | null }>
}

let picked: string | null = null

export function renderPause(plan: Plan, banner?: string) {
  const pick = plan.months.find((m) => m.month === picked)
  draw(`<div class="card appear">
    ${banner ? `<div class="toast ok" style="margin:0 0 12px">${esc(banner)}</div>` : ''}
    <div class="eyebrow">Pause a month</div>
    <h1>Which month do you want off?</h1>
    <p class="small muted" style="margin-top:4px">That month's charge is skipped. Your queue and your place in it are kept. Up to ${
      plan.maxInARow
    } months in a row.</p>
    <div class="months" role="group" aria-label="Billing months">${plan.months
      .map((m) => {
        const cls = m.paused ? 'paused' : m.month === picked ? 'picked' : ''
        const sub = m.paused ? 'Paused' : m.canPause ? `Charge ${day(m.chargeOn)}` : m.blockedBecause ?? ''
        return `<button class="month ${cls}" data-act="pick" data-month="${esc(m.month)}" ${m.canPause ? '' : 'disabled'} aria-pressed="${
          m.month === picked
        }"><span class="m">${esc(monthName(m.month, true))}</span><span class="small muted">${esc(sub)}</span></button>`
      })
      .join('')}</div>
    ${
      pick
        ? `<div class="soft appear" style="margin-top:12px">Pause <strong>${esc(monthName(pick.month, true))}</strong>? The ${esc(
            day(pick.chargeOn),
          )} charge is skipped and work picks up again the month after.</div>
          <div class="actions"><button class="primary" data-act="confirm">Pause ${esc(monthName(pick.month, true))}</button><button data-act="clear">Not now</button></div>`
        : ''
    }
  </div>`)

  on(
    {
      pick: (el) => {
        picked = el.dataset.month!
        renderPause(plan)
      },
      clear: () => {
        picked = null
        renderPause(plan)
      },
      confirm: async () => {
        const month = picked!
        await call('request_pause', { month })
        picked = null
        tell(`The client paused ${monthName(month, true)} (${month}) from the pause calendar. It's saved; don't pause it again.`)
        renderPause(await call<Plan>('plan_pause'), `${monthName(month, true)} is paused.`)
      },
    },
    () => renderPause(plan),
  )
}

/** After request_pause ran from chat, show the calendar with the result. */
export async function renderPauseDone(result: { month: string; alreadyPaused?: boolean }) {
  const plan = await call<Plan>('plan_pause')
  renderPause(plan, result.alreadyPaused ? `${monthName(result.month, true)} was already paused.` : `${monthName(result.month, true)} is paused.`)
}
