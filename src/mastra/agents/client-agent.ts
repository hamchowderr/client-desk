import { createTeamsAdapter } from '@chat-adapter/teams'
import { Agent } from '@mastra/core/agent'
import type { ChannelConfig, ChannelHandler } from '@mastra/core/channels'
import { Memory } from '@mastra/memory'
import { getDb } from '../../db/client'
import { type ChatSender, chatSender, linkCommand, redeemLinkCode } from '../../domain/identities'
import skills from '../../skills.generated'
import { toolFor } from '../mcp'
import { clientOps } from '../ops'

export const CLIENT_AGENT_ID = 'client-agent'

const NOT_LINKED =
  "Hi! I don't know who you are yet. Ask Chowderr for a link code, then send it here as \"link\" and the code (e.g. link K7QM-4XPA)."

/**
 * Who may talk to the agent, decided per message before it runs: the sender
 * must be a linked client contact (or send a link code). The run then acts as
 * that client, so tools only ever see that client's work.
 */
export const gate: ChannelHandler = async (thread, message, defaultHandler, ctx) => {
  if (message.author.isBot === true || message.author.isMe) return
  const platform = thread.adapter.name
  const db = getDb()
  const code = linkCommand(message.text)
  if (code) {
    try {
      const sender = await redeemLinkCode(db, platform, message.author.userId, code)
      await thread.post(`Linked. Hi ${sender?.name.split(' ')[0] ?? 'there'}, ask me about your work with Otaku Solutions any time.`)
    } catch {
      await thread.post("That code didn't work. It may be used or expired; ask Chowderr for a new one.")
    }
    return
  }
  const sender = await chatSender(db, platform, message.author.userId, message.author.email)
  if (!sender) {
    await thread.post(NOT_LINKED)
    return
  }
  ctx.requestContext.set('user', { id: `client:${sender.principal.clientId}:${sender.principal.label}`, principal: sender.principal, scopes: ['client'] })
  ctx.requestContext.set('sender', sender)
  await defaultHandler(thread, message)
}

/** Channels with credentials in the environment. Teams today; Slack, email and others plug in the same way. */
function channelsFromEnv(): ChannelConfig | undefined {
  const adapters: ChannelConfig['adapters'] = {}
  if (process.env.TEAMS_APP_ID) {
    adapters.teams = createTeamsAdapter({
      appType: process.env.TEAMS_APP_TENANT_ID ? 'SingleTenant' : 'MultiTenant',
      userName: 'Otaku Solutions',
    })
  }
  if (!Object.keys(adapters).length) return undefined
  return { adapters, handlers: { onDirectMessage: gate, onMention: gate, onSubscribedMessage: gate } }
}

const playbook = skills['client-agent']!.replace(/^---[\s\S]*?---\s*/, '')

export const clientAgent = new Agent({
  id: CLIENT_AGENT_ID,
  name: 'Otaku Solutions assistant',
  description: "A retainer client's assistant in their own chat: takes requests, reports status, never commits for Chowderr.",
  instructions: ({ requestContext }) => {
    const sender = requestContext?.get('sender') as ChatSender | undefined
    const who = sender
      ? `You are talking with ${sender.name} (${sender.role === 'owner' ? 'the retainer owner' : 'a team member'}) at ${sender.client}.`
      : ''
    return `${playbook}\n\n${who} Only the retainer owner can ask for a pause. Write short, plain replies.`
  },
  model: process.env.DESK_AGENT_MODEL ?? 'anthropic/claude-sonnet-5-5',
  tools: Object.fromEntries(clientOps.map((op) => [op.id, toolFor(op)])),
  ...(process.env.MASTRA_DATABASE_URL && { memory: new Memory({ options: { lastMessages: 20 } }) }),
  channels: channelsFromEnv(),
})
