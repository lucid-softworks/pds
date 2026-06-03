// Tiny "2h ago" formatter for post timestamps. Hand-rolled rather than
// pulling in dayjs/luxon — the in-repo client UI is supposed to read top to
// bottom in an afternoon, and the rounding rules below are all there is.
//
// Inputs that don't parse become 'unknown time' rather than throwing — the
// feed view is read-only, we'd rather render a slightly degraded card than
// blow up rendering the whole list.

export function relativeTime(input: string | Date, now: Date = new Date()): string {
  const date = typeof input === 'string' ? new Date(input) : input
  if (Number.isNaN(date.getTime())) return 'unknown time'

  const diffSec = Math.round((now.getTime() - date.getTime()) / 1000)
  if (diffSec < 0) return 'in the future'
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`

  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`

  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`

  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  if (diffDay < 30) return `${Math.round(diffDay / 7)}w ago`
  if (diffDay < 365) return `${Math.round(diffDay / 30)}mo ago`
  return `${Math.round(diffDay / 365)}y ago`
}
