# twilio-sms

Send and receive SMS via Twilio. Adds a `twilio-sms` channel adapter that
posts outbound messages through the Twilio Messages REST API and ingests
inbound SMS through a signed Twilio webhook routed by KinBot's built-in
plugin webhook dispatcher.

## Scope (v0.1)

In scope:
- Outbound SMS via `POST /2010-04-01/Accounts/{sid}/Messages.json`
- Inbound SMS via signed Twilio webhook (HMAC-SHA1, strict mode)
- Per-channel credentials (one Twilio account / number per channel)
- Vault-backed Auth Token (the field is `type:'password'`, auto-vaulted)

Out of scope (V2 candidates):
- MMS media download (`NumMedia > 0` is logged in metadata, but media
  URLs are not fetched, persisted, or rehydrated into attachments)
- Delivery status webhook (`MessageStatus` callbacks: sent, delivered,
  failed). The current `sendMessage` returns Twilio's synchronous status
  only (typically `queued`).
- Multi-number routing on a single channel (each channel binds to one
  `fromNumber`)
- Opt-out keyword handling (`STOP`, `UNSUBSCRIBE`, `HELP`). Twilio
  Advanced Opt-Out covers the carrier-mandated behavior server side; if
  you want the Kin to react to those keywords, do it at the prompt level
  for now.
- Voice (calls, recording, transcription). The plugin is SMS only.

## Prerequisites

1. A Twilio account (https://www.twilio.com/console)
2. A Twilio phone number with SMS capability enabled
3. A publicly reachable KinBot URL (e.g. `https://kinbot.example.com`).
   Twilio webhooks must hit a HTTPS endpoint that resolves to your
   KinBot host. ngrok or a Cloudflare Tunnel works for development.
4. The `PUBLIC_URL` env var set on the KinBot server, matching the URL
   Twilio is configured to call. The plugin uses this when reconstructing
   the canonical URL for signature validation.

## Setup

1. **Install the plugin.** From the KinBot Plugins UI, install
   `twilio-sms`. Activate it. The channel platform `twilio-sms` becomes
   available in the channel creation form.

2. **Create a channel.** In the Kin's Channels tab, "New channel",
   select Twilio SMS, and fill:
   - Account SID: your Twilio Account SID (starts with `AC...`).
   - Auth Token: your Twilio Auth Token. Stored in the KinBot vault
     (encrypted at rest), never logged.
   - From Number: the E.164 number that sends SMS (e.g. `+15551234567`).
     Must be a number you own on Twilio with SMS enabled.

3. **Note the channel ID.** It appears in the URL when viewing the
   channel, and on the channel detail page. It is a v4 UUID such as
   `11111111-1111-4111-8111-111111111111`.

4. **Configure the Twilio webhook.** In the Twilio Console:
   - Phone Numbers > Manage > Active numbers > select your number.
   - Messaging Configuration > "A message comes in".
   - Method: `HTTP POST`.
   - URL: `https://your-public-url/api/channels/plugin/twilio-sms/webhook/{channelId}`,
     substituting your KinBot public URL and the channel ID from step 3.
   - Save.

5. **Activate the channel.** Send "test" from your phone to the Twilio
   number. The message arrives in the Kin's chat with metadata
   describing the Twilio account, target number, and media count.

## Testing the webhook locally

You can simulate a Twilio inbound from the shell. Sign the canonical
string (URL + sorted form key/value pairs concatenated, no separators)
with the Auth Token, base64 the HMAC-SHA1 output, and set it as the
`X-Twilio-Signature` header:

```bash
URL='https://your-public-url/api/channels/plugin/twilio-sms/webhook/CHANNEL_ID'
AUTH_TOKEN='your_twilio_auth_token'
BODY='AccountSid=AC...&ApiVersion=2010-04-01&Body=hello&From=%2B15559998888&MessageSid=SMtest&NumMedia=0&SmsSid=SMtest&To=%2B15550001111'

# Build canonical string by hand (URL + sorted "key+value" pairs).
# This snippet hard-codes the sorted concatenation for the body above.
CANONICAL="${URL}AccountSidAC...ApiVersion2010-04-01BodyhelloFrom+15559998888MessageSidSMtestNumMedia0SmsSidSMtestTo+15550001111"

SIG=$(printf %s "$CANONICAL" | openssl dgst -sha1 -hmac "$AUTH_TOKEN" -binary | openssl base64)

curl -i -X POST "$URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Twilio-Signature: $SIG" \
  --data "$BODY"
```

Expect `HTTP/1.1 200 OK` with `Content-Type: application/xml` and an
empty `<Response></Response>` body. If you tamper with the body or use
the wrong Auth Token, you get `HTTP/1.1 403 Forbidden`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403 Forbidden: invalid Twilio signature` on Twilio retries | `PUBLIC_URL` env var on KinBot does not match the URL configured in Twilio Console, or the Auth Token in the channel config is stale. |
| `Twilio API error (HTTP 401)` from validateConfig | Wrong AccountSid or AuthToken. |
| Twilio error code 21211 on send | Invalid `To` number (not E.164, or not a real number). |
| Twilio error code 21610 on send | Recipient has unsubscribed (STOP). Resolve in Twilio Console. |
| Twilio error code 21408 on send | Country / region is blocked on your account. Enable Geo Permissions. |
| Twilio error code 11200 in Twilio Console logs | Twilio could not retrieve the webhook URL (timeout, 5xx, DNS). Check that `https://your-public-url/...` is reachable from the public internet and returns 2xx within a few seconds. |
| Inbound message arrives but the Kin sees no body | Twilio sent `NumMedia > 0` and the body is empty. MMS is out of scope; the metadata field `twilio.numMedia` records the count for the Kin to react to. |

## Security notes

- **Signature mode is strict.** The plugin rejects every request without
  a valid `X-Twilio-Signature` header, even if everything else looks
  right. SMS spoofing (a forged inbound posing as a known sender) is a
  real attack vector when the validation is loose; we will not soften
  this.
- **Auth Token storage.** The `authToken` field is declared
  `type:'password'` in the channel config schema, so KinBot replaces
  the plain value with `authTokenVaultKey` on persistence. The plugin
  resolves the vault key at use time via `getSecretValue`. The plain
  token never lands in the channels table or in plugin logs.
- **MMS, V1 stance.** When Twilio sends `NumMedia > 0`, the plugin
  records the count in `metadata.twilio.numMedia` but does not fetch
  the media URLs. Adding MMS means downloading media (Twilio media URLs
  require Basic auth on a separate domain), MIME sniffing, and
  attachment handling: deferred to V2.
- **Body goes to the LLM as-is.** No PII redaction. If you ingest SMS
  from third parties, consider whether that fits your data policy.
