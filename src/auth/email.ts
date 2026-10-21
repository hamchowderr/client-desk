import { crmFromEnv } from '../crm'

/**
 * Sign-in codes go out from the hub, through FluentCRM, so they come from the
 * same Otaku Solutions address as every other email and need no new mail account.
 */
export async function sendSignInCode(email: string, code: string) {
  const crm = crmFromEnv()
  if (!crm) throw new Error('Sign-in codes need FLUENTCRM_AUTH to send email')
  await crm.sendEmail(
    { email, firstName: '', lastName: '' },
    {
      subject: `${code} is your Otaku Solutions sign-in code`,
      html: `<p>Your sign-in code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
<p>Enter it on the Otaku Solutions sign-in page. It works once and expires in 10 minutes.</p>
<p>If you didn't try to sign in, you can ignore this email.</p>`,
    },
  )
}
