/**
 * Minimal Twilio REST API client for the twilio-sms plugin.
 *
 * Wraps the 2010-04-01 API surface:
 *   - GET  /Accounts/{Sid}.json       (used by validateConfig)
 *   - POST /Messages.json             (used by sendMessage)
 *
 * Auth: HTTP Basic, username = AccountSid, password = AuthToken.
 * Outbound POSTs are application/x-www-form-urlencoded.
 *
 * No third-party dependency: keeps the plugin self-contained and avoids
 * pulling the official twilio SDK (which is large and Node-flavored).
 */

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01'

export interface TwilioAuth {
  accountSid: string
  authToken: string
}

export interface TwilioApiError {
  status: number
  code?: number
  message: string
  moreInfo?: string
}

export class TwilioApiException extends Error {
  readonly status: number
  readonly twilioCode?: number
  readonly moreInfo?: string

  constructor(err: TwilioApiError) {
    super(`Twilio API error (HTTP ${err.status}${err.code ? `, code ${err.code}` : ''}): ${err.message}`)
    this.name = 'TwilioApiException'
    this.status = err.status
    this.twilioCode = err.code
    this.moreInfo = err.moreInfo
  }
}

function basicAuthHeader(sid: string, token: string): string {
  const raw = `${sid}:${token}`
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(raw, 'utf8').toString('base64')
    : btoa(raw)
  return `Basic ${b64}`
}

async function parseError(resp: Response): Promise<TwilioApiError> {
  let body: unknown = null
  try {
    body = await resp.json()
  } catch {
    // fall through to plain text
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    return {
      status: resp.status,
      code: typeof b.code === 'number' ? b.code : undefined,
      message: typeof b.message === 'string' ? b.message : `HTTP ${resp.status}`,
      moreInfo: typeof b.more_info === 'string' ? b.more_info : undefined,
    }
  }
  return { status: resp.status, message: `HTTP ${resp.status}` }
}

interface TwilioRequestOpts {
  auth: TwilioAuth
  endpoint: string
  method: 'GET' | 'POST'
  body?: URLSearchParams
}

export async function twilioApiRequest<T = unknown>(opts: TwilioRequestOpts): Promise<T> {
  const url = `${TWILIO_BASE}/Accounts/${encodeURIComponent(opts.auth.accountSid)}${opts.endpoint}`
  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(opts.auth.accountSid, opts.auth.authToken),
    Accept: 'application/json',
  }
  if (opts.method === 'POST' && opts.body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }

  const resp = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.method === 'POST' && opts.body ? opts.body.toString() : undefined,
  })

  if (!resp.ok) {
    throw new TwilioApiException(await parseError(resp))
  }
  return (await resp.json()) as T
}

// ─── Typed helpers ─────────────────────────────────────────────────────────

export interface TwilioAccount {
  sid: string
  friendly_name: string
  status: string
  type: string
}

export async function getAccount(auth: TwilioAuth): Promise<TwilioAccount> {
  return twilioApiRequest<TwilioAccount>({
    auth,
    endpoint: `/${encodeURIComponent(auth.accountSid)}.json`,
    method: 'GET',
  })
}

export interface TwilioMessageResource {
  sid: string
  status: string
  from: string
  to: string
  body: string
  date_created?: string
  error_code?: number | null
  error_message?: string | null
}

export interface SendSmsParams {
  auth: TwilioAuth
  from: string
  to: string
  body: string
}

export async function sendSms(params: SendSmsParams): Promise<TwilioMessageResource> {
  const form = new URLSearchParams()
  form.set('From', params.from)
  form.set('To', params.to)
  form.set('Body', params.body)
  return twilioApiRequest<TwilioMessageResource>({
    auth: params.auth,
    endpoint: '/Messages.json',
    method: 'POST',
    body: form,
  })
}
