import { and, eq, isNotNull } from 'drizzle-orm'
import type { CrmAdapter } from '../crm'
import type { DbOrTx } from '../db/client'
import { contacts } from '../db/schema'
import type { Recap } from './recap'

/**
 * Emails to a client's people when something needs them: work is ready for
 * review, Chowderr asked a question, or posted an update they should see. They
 * go out through the CRM's mailer, like sign-in codes.
 */
export type Notice =
  | { kind: 'review'; request: string; title: string; note: string; deliverableUrl?: string | null }
  | { kind: 'question'; request: string; title: string; question: string }
  | { kind: 'update'; request: string; title: string; body: string }

export type Email = { subject: string; html: string }

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const para = (s: string) => esc(s.trim()).replace(/\n+/g, '<br>')

/** A link that opens a new Claude chat with the question typed in. */
export const askClaudeUrl = (prompt: string) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`

const button = (href: string, label: string) =>
  `<p><a href="${esc(href)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#141413;color:#fff;text-decoration:none">${esc(label)}</a></p>`

const hello = (firstName: string) => `<p>Hi ${esc(firstName || 'there')},</p>`
const signOff = '<p>Chowderr<br>Otaku Solutions</p>'

export function noticeEmail(n: Notice, firstName: string): Email {
  const ask = (prompt: string, label: string) => button(askClaudeUrl(prompt), label)
  switch (n.kind) {
    case 'review':
      return {
        subject: `Ready for your review: ${n.title} (${n.request})`,
        html: `${hello(firstName)}
<p><strong>${esc(n.title)}</strong> is ready for you to look over.</p>
<p>${para(n.note)}</p>
${n.deliverableUrl ? button(n.deliverableUrl, 'Open what was delivered') : ''}
${ask(`Show me ${n.request}`, 'Review it in Claude')}
<p>If it looks good, say so there. If something needs changing, say what, and it goes back to the front of your queue.</p>
${signOff}`,
      }
    case 'question':
      return {
        subject: `A question about ${n.title} (${n.request})`,
        html: `${hello(firstName)}
<p>Before I can go further on <strong>${esc(n.title)}</strong>, I need to know:</p>
<p style="padding:10px 14px;border-left:3px solid #c96442">${para(n.question)}</p>
${ask(`I want to answer the question on ${n.request}`, 'Answer in Claude')}
<p>You can also just reply to this email.</p>
${signOff}`,
      }
    case 'update':
      return {
        subject: `Update on ${n.title} (${n.request})`,
        html: `${hello(firstName)}
<p>${para(n.body)}</p>
${ask(`Show me ${n.request}`, 'See it in Claude')}
${signOff}`,
      }
  }
}

export function recapEmail(r: Recap, firstName: string): Email {
  const list = (items: { id: string; title: string }[]) =>
    `<ul>${items.map((i) => `<li>${esc(i.title)} <span style="color:#73726c">(${esc(i.id)})</span></li>`).join('')}</ul>`
  const section = (title: string, items: { id: string; title: string }[]) =>
    items.length ? `<p><strong>${esc(title)}</strong></p>${list(items)}` : ''
  const quiet = !r.shipped.length && !r.inProgress.length && !r.upNext.length && !r.waitingOnYou.length
  return {
    subject: `Your week with Otaku Solutions: ${r.headline}`,
    html: `${hello(firstName)}
<p>Here's where your work stands this week.</p>
${section('Delivered', r.shipped)}
${section('In progress', r.inProgress)}
${section('Waiting on you', r.waitingOnYou)}
${section('Up next', r.upNext)}
${quiet ? '<p>Nothing is open right now. Whenever you have something new, send it over.</p>' : ''}
${button(askClaudeUrl('Show me my week'), 'See it in Claude')}
${signOff}`,
  }
}

/** Everyone on the client's side with an email. */
export async function recipients(db: DbOrTx, clientId: string) {
  return db
    .select({ name: contacts.name, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.clientId, clientId), isNotNull(contacts.email)))
}

/** Send one email to each of the client's people; returns who it went to. */
export async function emailClient(
  db: DbOrTx,
  crm: CrmAdapter,
  clientId: string,
  build: (firstName: string) => Email,
): Promise<string[]> {
  const sent: string[] = []
  for (const person of await recipients(db, clientId)) {
    const email = person.email!.trim()
    if (!email) continue
    const [first = '', ...rest] = person.name.trim().split(/\s+/)
    await crm.sendEmail({ email, firstName: first, lastName: rest.join(' ') }, build(first))
    sent.push(email)
  }
  return sent
}

/** Client emails are on unless DESK_CLIENT_EMAILS is "off". */
export const clientEmailsOn = () => (process.env.DESK_CLIENT_EMAILS ?? 'on').toLowerCase() !== 'off'
