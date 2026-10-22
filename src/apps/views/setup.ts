/**
 * The new-client form. Claude fills in what Chowderr said; Chowderr checks it,
 * fixes anything, and presses Create. One press adds the client, their main
 * contact, the retainer and (if done) the kickoff.
 */
import { call, draw, esc, on, tell } from '../kit'
import { type Overview, renderStatus } from './status'

type Setup = {
  name?: string
  code?: string
  company?: string
  timezone?: string
  contactName?: string
  contactEmail?: string
  monthlyRateCents?: number
  activeLimit?: number
  nextChargeAt?: string
  kickoffDone?: boolean
}
export type SetupDraft = { setup: Setup; codeTaken: boolean; missing: string[] }

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London']

const field = (key: keyof Setup, label: string, value: unknown, attrs = '', wide = false, hint = '') =>
  `<label class="field ${wide ? 'wide' : ''} ${hint ? 'bad' : ''}"><span>${esc(label)}</span><input name="${key}" value="${esc(value ?? '')}" ${attrs} />${
    hint ? `<span class="hint">${esc(hint)}</span>` : ''
  }</label>`

function read(): Setup {
  const val = (k: string) => (document.querySelector<HTMLInputElement>(`[name="${k}"]`)?.value ?? '').trim()
  const dollars = Number(val('rate').replace(/[$,\s]/g, ''))
  return {
    name: val('name'),
    code: val('code').toUpperCase(),
    company: val('company') || undefined,
    timezone: val('timezone'),
    contactName: val('contactName'),
    contactEmail: val('contactEmail'),
    monthlyRateCents: Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : undefined,
    activeLimit: Number(val('activeLimit')) || 1,
    nextChargeAt: val('nextChargeAt'),
    kickoffDone: document.querySelector<HTMLInputElement>('[name="kickoffDone"]')?.checked ?? false,
  }
}

function problems(s: Setup, codeTaken: boolean) {
  const out: Partial<Record<keyof Setup | 'rate', string>> = {}
  if (!s.name) out.name = 'Needed'
  if (!/^[A-Z0-9]{2,6}$/.test(s.code ?? '')) out.code = '2 to 6 letters or digits'
  else if (codeTaken) out.code = 'Already used by another client'
  if (!s.contactName) out.contactName = 'Needed'
  if (!/^\S+@\S+\.\S+$/.test(s.contactEmail ?? '')) out.contactEmail = 'A valid email'
  if (!s.monthlyRateCents) out.rate = 'e.g. 1500'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.nextChargeAt ?? '')) out.nextChargeAt = 'Pick a date'
  return out
}

export function renderSetup(d: SetupDraft, opts: { checked?: boolean } = {}) {
  const s = d.setup
  const bad = opts.checked ? problems(s, d.codeTaken) : d.codeTaken ? { code: 'Already used by another client' } : {}
  const zones = s.timezone && !ZONES.includes(s.timezone) ? [s.timezone, ...ZONES] : ZONES
  draw(`<div class="card appear">
    <div class="eyebrow">New client</div>
    <h1>${esc(s.name || 'Add a client')}</h1>
    <p class="small muted" style="margin-top:4px">Check the details, then Create. This adds the client, their main contact (who owns the retainer) and the retainer in one go.</p>
    <div class="fields">
      ${field('name', 'Client name', s.name, 'autocomplete="organization"', false, bad.name)}
      ${field('code', 'Code (for request ids)', s.code, 'maxlength="6" style="text-transform:uppercase"', false, bad.code)}
      ${field('company', 'Company (optional)', s.company, '', true)}
      ${field('contactName', 'Main contact', s.contactName, 'autocomplete="name"', false, bad.contactName)}
      ${field('contactEmail', 'Their email', s.contactEmail, 'type="email" autocomplete="email"', false, bad.contactEmail)}
      <label class="field ${bad.rate ? 'bad' : ''}"><span>Monthly rate ($)</span><input name="rate" inputmode="decimal" value="${
        s.monthlyRateCents ? esc(String(s.monthlyRateCents / 100)) : ''
      }" />${bad.rate ? `<span class="hint">${esc(bad.rate)}</span>` : ''}</label>
      ${field('nextChargeAt', 'First charge', s.nextChargeAt ? String(s.nextChargeAt).slice(0, 10) : '', 'type="date"', false, bad.nextChargeAt)}
      ${field('activeLimit', 'Requests at once', s.activeLimit ?? 1, 'type="number" min="1" max="10"')}
      <label class="field"><span>Time zone</span><select name="timezone">${zones
        .map((z) => `<option ${z === (s.timezone ?? 'America/New_York') ? 'selected' : ''}>${esc(z)}</option>`)
        .join('')}</select></label>
      <label class="check wide"><input type="checkbox" name="kickoffDone" ${s.kickoffDone ? 'checked' : ''}/> The kickoff call already happened</label>
    </div>
    <div class="actions">
      <button class="primary" data-act="create">Create client</button>
    </div>
  </div>`)

  on(
    {
      create: async () => {
        const next = read()
        const draft = { ...d, setup: next }
        if (Object.keys(problems(next, false)).length) return renderSetup(draft, { checked: true })
        try {
          const made = await call<Overview & { created: boolean }>('setup_client', next as Record<string, unknown>)
          tell(
            `Chowderr created the client ${next.name} (${next.code}) from the new-client form: contact ${next.contactName} <${next.contactEmail}>, $${(
              next.monthlyRateCents! / 100
            ).toFixed(2)}/month, first charge ${next.nextChargeAt}, kickoff ${next.kickoffDone ? 'done' : 'not yet'}. It's saved; don't create it again.`,
          )
          renderStatus(made, { admin: true })
        } catch (e) {
          const msg = (e as Error).message
          if (/taken/i.test(msg)) return renderSetup({ ...draft, codeTaken: true }, { checked: true })
          throw e
        }
      },
    },
    () => renderSetup(d, opts),
  )
}
