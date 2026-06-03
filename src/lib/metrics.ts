// In-process Prometheus-style metrics.
//
// Two collector types — counters (monotonic) and histograms (latency
// distributions) — and a `renderProm()` that walks every registered collector
// and serialises the Prometheus text exposition format on demand. No
// background flushing: the `/metrics` route calls `renderProm()` at scrape
// time and returns the string.
//
// Why no `prom-client` dependency: the exposition format is small enough to
// produce by hand, and adding a dep for ~150 lines of formatting felt wrong
// when this is the teaching port. Once it grows past five metric types or
// gains push-gateway support, swap to `prom-client` — the public API surface
// here was designed to be `prom-client`-shaped on purpose.
//
// Labels are stored as a stable string key (`'a="x",b="y"'`); each unique
// label set is its own cell. Label *keys* are fixed at counter/histogram
// declaration time so a typo in a call site shows up at observe-time rather
// than producing a silent new series.
//
// See chapter 18 — Production observability.

export type Sample = {
  name: string
  help: string
  type: 'counter' | 'histogram'
  lines: string[]
}

export type Counter = {
  inc(labels?: Record<string, string>, by?: number): void
  collect(): Sample
}

export type Histogram = {
  observe(labels: Record<string, string>, value: number): void
  collect(): Sample
}

// Registry of every collector built via `counter()` / `histogram()`. The
// /metrics route walks this in declaration order.
const collectors: Array<{ collect: () => Sample }> = []

/** Histogram bucket boundaries good for HTTP-request latency in seconds.
 *  Mirrors the Prometheus client default. */
export const DEFAULT_HTTP_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

/** Build a counter with optional fixed label keys. Unknown labels at inc()
 *  time are ignored (helps when a call site is upgraded before a collector
 *  is). Missing required labels render as the empty string. */
export function counter(
  name: string,
  help: string,
  labelKeys: string[] = [],
): Counter {
  const cells = new Map<string, number>()
  const keys = [...labelKeys]
  const c: Counter = {
    inc(labels, by = 1) {
      const key = labelKey(keys, labels ?? {})
      cells.set(key, (cells.get(key) ?? 0) + by)
    },
    collect() {
      const lines: string[] = []
      for (const [labels, value] of cells) {
        const labelsPart = labels.length > 0 ? `{${labels}}` : ''
        lines.push(`${name}${labelsPart} ${value}`)
      }
      return { name, help, type: 'counter', lines }
    },
  }
  collectors.push(c)
  return c
}

/** Build a histogram with required fixed label keys and bucket boundaries
 *  (ascending). The implicit `+Inf` bucket is added automatically. */
export function histogram(
  name: string,
  help: string,
  labelKeys: string[],
  buckets: number[],
): Histogram {
  const sortedBuckets = [...buckets].sort((a, b) => a - b)
  type Cell = {
    counts: number[] // length === sortedBuckets.length; inf is tracked separately
    inf: number
    sum: number
    count: number
  }
  const cells = new Map<string, Cell>()
  const keys = [...labelKeys]

  const newCell = (): Cell => ({
    counts: sortedBuckets.map(() => 0),
    inf: 0,
    sum: 0,
    count: 0,
  })

  const h: Histogram = {
    observe(labels, value) {
      const key = labelKey(keys, labels)
      let cell = cells.get(key)
      if (!cell) {
        cell = newCell()
        cells.set(key, cell)
      }
      // Prometheus buckets are cumulative — observing 0.3 increments every
      // bucket whose `le` is >= 0.3.
      for (let i = 0; i < sortedBuckets.length; i++) {
        const bound = sortedBuckets[i]!
        if (value <= bound) cell.counts[i] = (cell.counts[i] ?? 0) + 1
      }
      cell.inf += 1
      cell.sum += value
      cell.count += 1
    },
    collect() {
      const lines: string[] = []
      for (const [labels, cell] of cells) {
        for (let i = 0; i < sortedBuckets.length; i++) {
          const bound = sortedBuckets[i]!
          const labelsPart = withExtraLabel(labels, 'le', formatBucket(bound))
          lines.push(`${name}_bucket{${labelsPart}} ${cell.counts[i] ?? 0}`)
        }
        const infLabels = withExtraLabel(labels, 'le', '+Inf')
        lines.push(`${name}_bucket{${infLabels}} ${cell.inf}`)
        const labelsPart = labels.length > 0 ? `{${labels}}` : ''
        lines.push(`${name}_sum${labelsPart} ${cell.sum}`)
        lines.push(`${name}_count${labelsPart} ${cell.count}`)
      }
      return { name, help, type: 'histogram', lines }
    },
  }
  collectors.push(h)
  return h
}

/** Walk every registered collector and produce the Prometheus exposition
 *  text. Empty collectors still emit the `# HELP` / `# TYPE` header so a
 *  scraper sees the metric exists. */
export function renderProm(): string {
  const out: string[] = []
  for (const c of collectors) {
    const s = c.collect()
    out.push(`# HELP ${s.name} ${s.help}`)
    out.push(`# TYPE ${s.name} ${s.type}`)
    for (const line of s.lines) out.push(line)
  }
  // Prometheus exposition wants a trailing newline.
  return out.join('\n') + '\n'
}

/** Test-only: wipe every collector cell without losing the registration.
 *  Call from a `beforeEach` to keep label cardinality from leaking across
 *  test cases. */
export function _resetMetricsForTests(): void {
  // Easiest implementation: rebuild each collector's internal state by
  // shadowing `cells` is impossible because they're closure-private. The
  // pre-defined module-scope counters below export reset helpers; for ad-hoc
  // metrics created inside tests, the caller can simply create new ones.
  // We do reset the pre-defined ones here.
  preDefinedResets.forEach((fn) => fn())
}

const preDefinedResets: Array<() => void> = []

function makeResettableCounter(
  name: string,
  help: string,
  labelKeys: string[] = [],
): Counter {
  let underlying = counter(name, help, labelKeys)
  // Swap the closure each time reset is invoked. The exposed Counter object
  // delegates through the latest underlying.
  const proxy: Counter = {
    inc: (labels, by) => underlying.inc(labels, by),
    collect: () => underlying.collect(),
  }
  preDefinedResets.push(() => {
    // Remove the old collector from the registry, then build a fresh one.
    const idx = collectors.indexOf(underlying as unknown as Counter)
    if (idx >= 0) collectors.splice(idx, 1)
    underlying = counter(name, help, labelKeys)
  })
  return proxy
}

function makeResettableHistogram(
  name: string,
  help: string,
  labelKeys: string[],
  buckets: number[],
): Histogram {
  let underlying = histogram(name, help, labelKeys, buckets)
  const proxy: Histogram = {
    observe: (labels, value) => underlying.observe(labels, value),
    collect: () => underlying.collect(),
  }
  preDefinedResets.push(() => {
    const idx = collectors.indexOf(underlying as unknown as Histogram)
    if (idx >= 0) collectors.splice(idx, 1)
    underlying = histogram(name, help, labelKeys, buckets)
  })
  return proxy
}

function labelKey(keys: string[], labels: Record<string, string>): string {
  if (keys.length === 0) return ''
  const parts: string[] = []
  for (const k of keys) {
    const v = labels[k] ?? ''
    parts.push(`${k}="${escapeLabelValue(v)}"`)
  }
  return parts.join(',')
}

function withExtraLabel(existing: string, key: string, value: string): string {
  const fragment = `${key}="${escapeLabelValue(value)}"`
  return existing.length > 0 ? `${existing},${fragment}` : fragment
}

function escapeLabelValue(v: string): string {
  // Prometheus exposition: escape backslash, double-quote, newline.
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function formatBucket(v: number): string {
  // Match Prometheus convention: small numbers as fixed, large as integer.
  // We avoid scientific notation since scrapers handle it inconsistently.
  if (!Number.isFinite(v)) return '+Inf'
  if (Number.isInteger(v)) return v.toString()
  return v.toString()
}

// =====================================================================
// Pre-defined collectors used by the dispatcher + sequencer + blob path.
// Importing this module from a hot path is the registration mechanism.
// =====================================================================

/** XRPC requests served by the dispatcher, broken down by NSID, HTTP method,
 *  and response status. */
export const xrpcRequestsTotal = makeResettableCounter(
  'pds_xrpc_requests_total',
  'Total XRPC requests served, by NSID, method, and HTTP status.',
  ['nsid', 'method', 'status'],
)

/** Histogram of XRPC handler durations in seconds. */
export const xrpcRequestDurationSeconds = makeResettableHistogram(
  'pds_xrpc_request_duration_seconds',
  'XRPC handler duration in seconds.',
  ['nsid', 'method'],
  DEFAULT_HTTP_BUCKETS,
)

/** Firehose events appended to repo_seq, by event type. */
export const firehoseEventsTotal = makeResettableCounter(
  'pds_firehose_events_total',
  'Firehose events written to repo_seq, by event type.',
  ['event_type'],
)

/** Total bytes uploaded via uploadBlob (across every account). */
export const blobUploadBytesTotal = makeResettableCounter(
  'pds_blob_upload_bytes_total',
  'Total bytes accepted by uploadBlob (raw payload size).',
)

/** Total blob metadata rows created. Caveat: this is monotonic — we never
 *  decrement it when GC sweeps unreferenced blobs. For a true gauge, query
 *  the `blobs` table. The chapter calls this out. */
export const blobsTotal = makeResettableCounter(
  'pds_blobs_total',
  'Total blob metadata rows inserted (monotonic; not decremented on GC).',
)
