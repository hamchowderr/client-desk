import type { CrmAdapter, CrmContact } from './types'

/**
 * FluentCRM on the hub, over its REST API with a WordPress application password.
 * New contacts are added as "transactional" (clients, not a marketing opt-in);
 * an existing contact keeps its status, so an unsubscribe is never undone.
 */
export class FluentCrm implements CrmAdapter {
  readonly name = 'fluentcrm'
  private readonly ensured = new Set<string>()

  constructor(
    private readonly baseUrl: string,
    private readonly auth: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/wp-json/fluent-crm/v2${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(this.auth).toString('base64')}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`FluentCRM ${method} ${path} answered ${res.status}`)
    return (await res.json()) as T
  }

  private async ensureTags(tags: { slug: string; title: string }[]) {
    for (const tag of tags) {
      if (this.ensured.has(tag.slug)) continue
      const found = await this.call<{ tags: { data: { slug: string }[] } }>(
        'GET',
        `/tags?search=${encodeURIComponent(tag.slug)}&per_page=50`,
      )
      if (!found.tags.data.some((t) => t.slug === tag.slug)) {
        await this.call('POST', '/tags', { title: tag.title, slug: tag.slug })
      }
      this.ensured.add(tag.slug)
    }
  }

  /** The subscriber id for this email, adding them as transactional if FluentCRM doesn't have them. */
  private async subscriberId(contact: CrmContact): Promise<number> {
    const search = await this.call<{ subscribers: { data: { id: number; email: string }[] } }>(
      'GET',
      `/subscribers?search=${encodeURIComponent(contact.email)}&per_page=10`,
    )
    const found = search.subscribers.data.find((s) => s.email.toLowerCase() === contact.email.toLowerCase())?.id
    if (found) return found
    const created = await this.call<{ contact: { id: number } }>('POST', '/subscribers', {
      email: contact.email,
      first_name: contact.firstName,
      last_name: contact.lastName,
      status: 'transactional',
    })
    return created.contact.id
  }

  async syncContact(contact: CrmContact, tags: { attach: { slug: string; title: string }[]; detach: string[] }) {
    const id = await this.subscriberId(contact)
    await this.ensureTags(tags.attach)
    await this.call('POST', '/subscribers/sync-segments', {
      type: 'tags',
      subscribers: [id],
      find_by: 'slug',
      attach: tags.attach.map((t) => t.slug),
      detach: tags.detach,
    })
  }

  /** A one-off email through the hub's own mailer (FluentCRM's "send email to contact"), sent at once. */
  async sendEmail(contact: CrmContact, email: { subject: string; html: string }) {
    const id = await this.subscriberId(contact)
    await this.call('POST', `/subscribers/${id}/emails/send`, {
      campaign: { email_subject: email.subject, email_body: email.html },
    })
  }
}
