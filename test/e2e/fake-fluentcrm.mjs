// A stand-in for FluentCRM's REST API, for local smoke tests: prints every email it is asked to send.
import { createServer } from 'node:http'
const subs = []
createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url, 'http://x')
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)) }
  const path = url.pathname.replace('/wp-json/fluent-crm/v2', '')
  if (req.method === 'GET' && path === '/subscribers') return json({ subscribers: { data: subs.filter((s) => s.email.includes(url.searchParams.get('search') ?? '')) } })
  if (req.method === 'POST' && path === '/subscribers') { const s = { id: subs.length + 1, ...JSON.parse(body) }; subs.push(s); return json({ contact: s }) }
  const m = /^\/subscribers\/(\d+)\/emails\/send$/.exec(path)
  if (req.method === 'POST' && m) {
    const { campaign } = JSON.parse(body)
    console.log(JSON.stringify({ to: subs[Number(m[1]) - 1]?.email, subject: campaign.email_subject }))
    return json({ message: 'sent' })
  }
  res.statusCode = 404; json({})
}).listen(Number(process.env.PORT ?? 4300))
