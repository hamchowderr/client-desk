import { FluentCrm } from './fluentcrm'
import type { CrmAdapter } from './types'

export type { CrmAdapter, CrmContact } from './types'

let configured: CrmAdapter | null | undefined

/** The CRM from the environment, or null when none is set up (the desk works without one). */
export function crmFromEnv(): CrmAdapter | null {
  if (configured !== undefined) return configured
  const auth = process.env.FLUENTCRM_AUTH
  configured = auth ? new FluentCrm(process.env.FLUENTCRM_URL ?? 'https://hub.otakusolutions.io', auth) : null
  return configured
}
