export type CrmContact = { email: string; firstName: string; lastName: string }

/** Where the desk mirrors its clients. FluentCRM today; HighLevel and others fit the same shape. */
export interface CrmAdapter {
  readonly name: string
  /** Create the contact if it is new, then attach and detach tags (by slug). */
  syncContact(contact: CrmContact, tags: { attach: { slug: string; title: string }[]; detach: string[] }): Promise<void>
  /** Send one email right away (sign-in codes). */
  sendEmail(contact: CrmContact, email: { subject: string; html: string }): Promise<void>
}
