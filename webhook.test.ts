import { describe, it, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import twilioSmsPlugin from './index'

// ─── Test fixtures ──────────────────────────────────────────────────────────

const ACCOUNT_SID = 'ACtest1234567890abcdef'
const AUTH_TOKEN = 'test_token_super_secret'
const FROM_NUMBER = '+15550001111'
const CHANNEL_ID = '11111111-1111-4111-8111-111111111111'
const PUBLIC_URL = 'https://kinbot.test'
const WEBHOOK_PATH = `/api/channels/plugin/twilio-sms/webhook/${CHANNEL_ID}`
const FULL_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof twilioSmsPlugin>[0]['log']

function buildAdapter() {
  return twilioSmsPlugin({
    config: {},
    log: noopLog,
    manifest: { name: 'twilio-sms', version: '0.1.0' },
  }).channels['twilio-sms']
}

function channelConfig(): Record<string, unknown> {
  return {
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    fromNumber: FROM_NUMBER,
  }
}

function inboundSmsForm(): URLSearchParams {
  // Realistic Twilio inbound payload subset (production webhooks carry more
  // fields, but the canonical signing string includes everything Twilio sent).
  const form = new URLSearchParams()
  form.set('AccountSid', ACCOUNT_SID)
  form.set('ApiVersion', '2010-04-01')
  form.set('Body', 'Hello from a real phone')
  form.set('From', '+15559998888')
  form.set('FromCountry', 'US')
  form.set('MessageSid', 'SMtestincoming1234567890abcdef')
  form.set('NumMedia', '0')
  form.set('NumSegments', '1')
  form.set('SmsMessageSid', 'SMtestincoming1234567890abcdef')
  form.set('SmsSid', 'SMtestincoming1234567890abcdef')
  form.set('SmsStatus', 'received')
  form.set('To', FROM_NUMBER)
  return form
}

/**
 * Recompute Twilio's canonical signature here, independently of the
 * production code path, so that a regression in webhookSecurity.ts cannot
 * silently agree with itself.
 */
function signTwilio(authToken: string, url: string, params: URLSearchParams): string {
  const keys = Array.from(new Set(Array.from(params.keys()))).sort()
  let canonical = url
  for (const k of keys) {
    for (const v of params.getAll(k)) {
      canonical += k + v
    }
  }
  return createHmac('sha1', authToken).update(canonical, 'utf8').digest('base64')
}

function makeRequest(form: URLSearchParams, signature: string | null): Request {
  const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' })
  if (signature !== null) {
    headers.set('X-Twilio-Signature', signature)
  }
  return new Request(FULL_URL, {
    method: 'POST',
    headers,
    body: form.toString(),
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('twilio-sms handleInboundWebhook', () => {
  it('accepts a request with a valid signature and produces an IncomingMessage', async () => {
    process.env.PUBLIC_URL = PUBLIC_URL
    const adapter = buildAdapter()
    const form = inboundSmsForm()
    const sig = signTwilio(AUTH_TOKEN, FULL_URL, form)
    const req = makeRequest(form, sig)

    const result = await adapter.handleInboundWebhook!(CHANNEL_ID, channelConfig(), req)

    expect(result.incoming).not.toBeNull()
    const inc = result.incoming!
    expect(inc.platformUserId).toBe('+15559998888')
    expect(inc.platformChatId).toBe('+15559998888')
    expect(inc.platformMessageId).toBe('SMtestincoming1234567890abcdef')
    expect(inc.content).toBe('Hello from a real phone')
    expect(inc.metadata).toEqual({
      twilio: { accountSid: ACCOUNT_SID, toNumber: FROM_NUMBER, numMedia: 0 },
    })

    expect(result.response.status).toBe(200)
    expect(result.response.headers.get('Content-Type')).toBe('application/xml')
    const xml = await result.response.text()
    expect(xml).toContain('<Response></Response>')
  })

  it('rejects a request with an invalid signature (no IncomingMessage, HTTP 403)', async () => {
    process.env.PUBLIC_URL = PUBLIC_URL
    const adapter = buildAdapter()
    const form = inboundSmsForm()
    // Sign with the wrong token to produce a deterministic-but-invalid sig.
    const wrongSig = signTwilio('not_the_real_token', FULL_URL, form)
    const req = makeRequest(form, wrongSig)

    const result = await adapter.handleInboundWebhook!(CHANNEL_ID, channelConfig(), req)

    expect(result.incoming).toBeNull()
    expect(result.response.status).toBe(403)
    const txt = await result.response.text()
    expect(txt).toContain('Forbidden')
  })

  it('rejects a request with no X-Twilio-Signature header (no IncomingMessage, HTTP 403)', async () => {
    process.env.PUBLIC_URL = PUBLIC_URL
    const adapter = buildAdapter()
    const form = inboundSmsForm()
    const req = makeRequest(form, null)

    const result = await adapter.handleInboundWebhook!(CHANNEL_ID, channelConfig(), req)

    expect(result.incoming).toBeNull()
    expect(result.response.status).toBe(403)
  })
})
