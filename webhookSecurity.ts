/**
 * Twilio webhook signature validation (HMAC-SHA1).
 *
 * Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * Canonical string for application/x-www-form-urlencoded webhooks:
 *   URL + sortedKey1 + value1 + sortedKey2 + value2 + ...
 *
 * The signature is HMAC-SHA1 of that canonical string keyed by the Auth
 * Token, base64-encoded. Twilio sends it as the X-Twilio-Signature header.
 *
 * Comparison must be constant-time to avoid leaking the expected signature
 * length / prefix via timing side channels.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Compute the Twilio-canonical signature for a given URL + form params,
 * using HMAC-SHA1 keyed by the Auth Token. Returns the base64 string.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams,
): string {
  // Twilio collapses duplicate keys by sorting alphabetically and
  // concatenating each (key, value) pair without separators. For multi-value
  // params (rare for SMS) we preserve insertion order within the same key
  // after sorting, which matches Twilio's reference implementations.
  const keys = Array.from(new Set(Array.from(params.keys()))).sort()
  let canonical = url
  for (const k of keys) {
    for (const v of params.getAll(k)) {
      canonical += k + v
    }
  }
  return createHmac('sha1', authToken).update(canonical, 'utf8').digest('base64')
}

/**
 * Validate the X-Twilio-Signature header against the expected signature.
 *
 * Returns true only if a signature is present, decodes to the expected
 * length, and matches via timing-safe comparison. Any missing / malformed
 * input returns false. A dummy compare on length mismatch keeps the
 * function constant-time relative to the signature length.
 */
export function validateTwilioSignature(
  authToken: string,
  signature: string | undefined | null,
  url: string,
  params: URLSearchParams,
): boolean {
  if (!authToken || !signature) {
    return false
  }
  const expected = computeTwilioSignature(authToken, url, params)
  const expectedBuf = Buffer.from(expected, 'utf8')
  const providedBuf = Buffer.from(signature, 'utf8')
  if (expectedBuf.length !== providedBuf.length) {
    // Dummy compare to keep timing similar to the matched-length path.
    timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return timingSafeEqual(expectedBuf, providedBuf)
}
