// Behaviour contract for the in-process metrics collectors.
//
// The pre-defined collectors live at module scope so import order matters
// across the suite; this file builds *new* counter/histogram instances per
// test and asserts on their collect() output directly, sidestepping the
// shared registry.

import { describe, expect, it } from 'vitest'
import {
  counter,
  histogram,
  renderProm,
  DEFAULT_HTTP_BUCKETS,
} from './metrics'

describe('counter', () => {
  it('reports a single line per unique label set', () => {
    const c = counter('test_counter_a', 'help', ['status'])
    c.inc({ status: '200' })
    c.inc({ status: '200' })
    c.inc({ status: '500' })
    const sample = c.collect()
    expect(sample.type).toBe('counter')
    expect(sample.name).toBe('test_counter_a')
    expect(sample.lines).toHaveLength(2)
    expect(sample.lines).toContain('test_counter_a{status="200"} 2')
    expect(sample.lines).toContain('test_counter_a{status="500"} 1')
  })

  it('supports a label-less counter', () => {
    const c = counter('test_counter_b', 'help')
    c.inc(undefined, 5)
    c.inc()
    expect(c.collect().lines).toEqual(['test_counter_b 6'])
  })

  it('different label sets produce different cells', () => {
    const c = counter('test_counter_c', 'help', ['a', 'b'])
    c.inc({ a: 'x', b: 'y' })
    c.inc({ a: 'x', b: 'z' })
    expect(c.collect().lines).toHaveLength(2)
  })

  it('escapes quotes and newlines in label values', () => {
    const c = counter('test_counter_d', 'help', ['raw'])
    c.inc({ raw: 'has "quotes" and\nnewline' })
    expect(c.collect().lines[0]).toBe(
      'test_counter_d{raw="has \\"quotes\\" and\\nnewline"} 1',
    )
  })
})

describe('histogram', () => {
  it('updates the right buckets, _sum, and _count', () => {
    const h = histogram('test_hist_a', 'help', ['nsid'], [0.1, 0.5, 1])
    h.observe({ nsid: 'foo' }, 0.05)
    h.observe({ nsid: 'foo' }, 0.3)
    h.observe({ nsid: 'foo' }, 2)
    const sample = h.collect()
    expect(sample.type).toBe('histogram')
    // 0.1: covers 0.05 → 1
    expect(sample.lines).toContain('test_hist_a_bucket{nsid="foo",le="0.1"} 1')
    // 0.5: covers 0.05 and 0.3 → 2
    expect(sample.lines).toContain('test_hist_a_bucket{nsid="foo",le="0.5"} 2')
    // 1: covers 0.05 and 0.3 → 2 (the 2.0 observation is over the cap)
    expect(sample.lines).toContain('test_hist_a_bucket{nsid="foo",le="1"} 2')
    // +Inf: all 3
    expect(sample.lines).toContain('test_hist_a_bucket{nsid="foo",le="+Inf"} 3')
    expect(sample.lines).toContain('test_hist_a_count{nsid="foo"} 3')
    // sum = 0.05 + 0.3 + 2 = 2.35
    const sumLine = sample.lines.find((l) => l.startsWith('test_hist_a_sum'))
    expect(sumLine).toBeDefined()
    expect(Number(sumLine!.split(' ').pop())).toBeCloseTo(2.35, 6)
  })

  it('keeps separate cells per label set', () => {
    const h = histogram('test_hist_b', 'help', ['nsid'], [1])
    h.observe({ nsid: 'a' }, 0.5)
    h.observe({ nsid: 'b' }, 5)
    const lines = h.collect().lines
    expect(lines).toContain('test_hist_b_count{nsid="a"} 1')
    expect(lines).toContain('test_hist_b_count{nsid="b"} 1')
  })
})

describe('renderProm', () => {
  it('emits HELP/TYPE blocks for every registered collector', () => {
    // Build a unique-named pair so we can assert their presence regardless of
    // what other tests in this file added.
    const c = counter('render_test_counter', 'a help string', ['k'])
    c.inc({ k: 'v' })
    const h = histogram(
      'render_test_hist',
      'another help',
      ['k'],
      DEFAULT_HTTP_BUCKETS,
    )
    h.observe({ k: 'v' }, 0.01)
    const text = renderProm()
    expect(text).toContain('# HELP render_test_counter a help string')
    expect(text).toContain('# TYPE render_test_counter counter')
    expect(text).toContain('render_test_counter{k="v"} 1')
    expect(text).toContain('# HELP render_test_hist another help')
    expect(text).toContain('# TYPE render_test_hist histogram')
    expect(text).toContain('render_test_hist_bucket{k="v",le="0.005"} 0')
    expect(text).toContain('render_test_hist_bucket{k="v",le="0.01"} 1')
    expect(text).toContain('render_test_hist_count{k="v"} 1')
    // Must end with a newline so a scrape concat is valid.
    expect(text.endsWith('\n')).toBe(true)
  })

  it('parses every non-comment line as `name{labels} value`', () => {
    const text = renderProm()
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      if (line.startsWith('#')) continue
      // Match: name with optional {labels} then space then numeric value
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? \S+$/)
    }
  })
})
