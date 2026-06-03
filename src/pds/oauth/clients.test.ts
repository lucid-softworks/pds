import { describe, expect, it } from 'vitest'
import { validateClientMetadata } from './clients'

const baseDoc = {
  client_id: 'https://app.example.com/client-metadata.json',
  redirect_uris: ['https://app.example.com/cb'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: 'atproto transition:generic',
  token_endpoint_auth_method: 'none',
  dpop_bound_access_tokens: true,
}

describe('validateClientMetadata', () => {
  it('accepts a well-formed atproto client document', () => {
    const out = validateClientMetadata(baseDoc, baseDoc.client_id)
    expect(out.client_id).toBe(baseDoc.client_id)
    expect(out.redirect_uris).toEqual(baseDoc.redirect_uris)
  })

  it('rejects when document.client_id does not match the expected URL', () => {
    expect(() =>
      validateClientMetadata(baseDoc, 'https://different.example.com/x'),
    ).toThrow(/mismatch/)
  })

  it('rejects when redirect_uris is missing or empty', () => {
    expect(() =>
      validateClientMetadata(
        { ...baseDoc, redirect_uris: [] },
        baseDoc.client_id,
      ),
    ).toThrow(/redirect_uris/)
    expect(() =>
      validateClientMetadata(
        { ...baseDoc, redirect_uris: undefined },
        baseDoc.client_id,
      ),
    ).toThrow(/redirect_uris/)
  })

  it('rejects when dpop_bound_access_tokens is not true', () => {
    expect(() =>
      validateClientMetadata(
        { ...baseDoc, dpop_bound_access_tokens: false },
        baseDoc.client_id,
      ),
    ).toThrow(/dpop_bound_access_tokens/)
  })

  it('rejects non-object input', () => {
    expect(() =>
      validateClientMetadata('not an object', baseDoc.client_id),
    ).toThrow(/must be a JSON object/)
  })

  it('preserves extra fields through validation', () => {
    const out = validateClientMetadata(
      { ...baseDoc, client_name: 'My App', logo_uri: 'https://x/img.png' },
      baseDoc.client_id,
    )
    expect(out['client_name']).toBe('My App')
    expect(out['logo_uri']).toBe('https://x/img.png')
  })
})
