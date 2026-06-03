// End-to-end metrics endpoint behaviour.
//
// Two top-level describes — one with PDS_METRICS=true, one without. We can't
// flip the env var mid-file because `getConfig()` caches on first read, so we
// rely on vitest's per-file fork isolation and split the cases into two
// files… except we don't want two files. Instead we test the pure handler
// (`handleMetrics`) under the enabled case, and assert the disabled case via
// a direct rebuild of the config gate (the export is small and the gate's
// logic is `getConfig().metricsEnabled ? 200 : 404`).
//
// After the enabled-case path, we drive a few XRPC requests through
// `dispatch()` and assert the `pds_xrpc_requests_total` counter ticked. That
// catches a regression where the dispatcher accidentally stops emitting
// metrics for a status code or a label.

process.env.PDS_METRICS = 'true'

import { setupTestDbEnv, migrateProcessDb } from '../db'
setupTestDbEnv()

import { beforeAll, describe, expect, it } from 'vitest'
import { handleMetrics } from '~/routes/metrics'
import { dispatch, HandlerRegistry } from '~/pds/xrpc/server'

beforeAll(async () => {
  await migrateProcessDb()
})

describe('GET /metrics with PDS_METRICS=true', () => {
  it('returns 200 with the Prometheus content type', async () => {
    const res = handleMetrics()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/plain.*version=0\.0\.4/)
    const text = await res.text()
    expect(text.length).toBeGreaterThan(0)
    // Pre-defined metric names are wired at import time.
    expect(text).toContain('# TYPE pds_xrpc_requests_total counter')
    expect(text).toContain('# TYPE pds_xrpc_request_duration_seconds histogram')
    expect(text).toContain('# TYPE pds_firehose_events_total counter')
    expect(text).toContain('# TYPE pds_blob_upload_bytes_total counter')
    expect(text).toContain('# TYPE pds_blobs_total counter')
  })

  it('counts XRPC requests dispatched through the server', async () => {
    // Stand up a tiny throwaway registry so we don't depend on the real
    // handler set being importable from this test's env (a couple of
    // handlers want OAuth env vars to be set).
    const registry = new HandlerRegistry()
    registry.register('test.echo', {
      method: 'GET',
      handler: async () => ({ ok: true }),
    })

    const url = new URL('http://localhost/xrpc/test.echo')
    await dispatch(registry, 'test.echo', new Request(url))
    await dispatch(registry, 'test.echo', new Request(url))
    // Unknown nsid → MethodNotImplemented; should still tick the counter
    // with status=404.
    await dispatch(
      registry,
      'no.such.method',
      new Request(new URL('http://localhost/xrpc/no.such.method')),
    )

    const text = await handleMetrics().text()
    const matchOk = text.match(
      /pds_xrpc_requests_total\{nsid="test\.echo",method="GET",status="200"\}\s+(\d+)/,
    )
    expect(matchOk).not.toBeNull()
    expect(Number(matchOk![1])).toBeGreaterThanOrEqual(2)

    const matchNotFound = text.match(
      /pds_xrpc_requests_total\{nsid="no\.such\.method",method="GET",status="404"\}\s+(\d+)/,
    )
    expect(matchNotFound).not.toBeNull()
    expect(Number(matchNotFound![1])).toBeGreaterThanOrEqual(1)

    // The duration histogram saw at least 2 observations for test.echo.
    const matchHistCount = text.match(
      /pds_xrpc_request_duration_seconds_count\{nsid="test\.echo",method="GET"\}\s+(\d+)/,
    )
    expect(matchHistCount).not.toBeNull()
    expect(Number(matchHistCount![1])).toBeGreaterThanOrEqual(2)
  })
})

// The PDS_METRICS=false → 404 path runs in a sibling file
// (`metrics-disabled.test.ts`) so the env flag is read fresh in its own fork.
