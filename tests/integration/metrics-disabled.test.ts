// Fork-isolated counterpart to metrics-endpoint.test.ts.
//
// `getConfig()` caches on first read, so to assert that PDS_METRICS=false
// produces a 404 we need a separate file (vitest forks per file). Setting
// the env var explicitly to '' makes the default-off path concrete.

process.env.PDS_METRICS = ''

import { setupTestDbEnv, migrateProcessDb } from '../db'
setupTestDbEnv()

import { beforeAll, describe, expect, it } from 'vitest'
import { handleMetrics } from '~/routes/metrics'

beforeAll(async () => {
  await migrateProcessDb()
})

describe('GET /metrics with PDS_METRICS unset', () => {
  it('returns 404', async () => {
    const res = handleMetrics()
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).toContain('not found')
  })
})
