import { TZDate } from '@date-fns/tz'
import { addDays, addMonths, endOfDay, getDaysInMonth, isWeekend } from 'date-fns'

/** Messages sent before this hour, client's local time, on a business day get a reply that day. */
export const SAME_DAY_CUTOFF_HOUR = 22

/**
 * When the reply to something received at `receivedAt` is due, per the Retainer page:
 * "Sent before 10pm your time on a business day, the reply lands that day."
 * Anything later, or on a weekend, is due by the end of the next business day.
 * Public holidays are not modelled.
 */
export function replyDueAt(receivedAt: Date, timeZone: string): Date {
  const local = new TZDate(receivedAt, timeZone)
  if (!isWeekend(local) && local.getHours() < SAME_DAY_CUTOFF_HOUR) {
    return new Date(endOfDay(local).getTime())
  }
  let next = addDays(local, 1)
  while (isWeekend(next)) next = addDays(next, 1)
  return new Date(endOfDay(next).getTime())
}

/** YYYY-MM for a month offset from a date (UTC). */
export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7)
}

export function parseMonth(month: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) throw new Error(`Month must look like 2026-12, got "${month}"`)
  const mm = Number(m[2])
  if (mm < 1 || mm > 12) throw new Error(`Month must look like 2026-12, got "${month}"`)
  return { year: Number(m[1]), month: mm }
}

export function shiftMonth(month: string, by: number): string {
  const { year, month: mm } = parseMonth(month)
  return monthKey(addMonths(new Date(Date.UTC(year, mm - 1, 1)), by))
}

/**
 * The charge date that opens `month`, for a subscription anchored on `anchor`
 * (the day of month it renews, clamped to short months). UTC.
 */
export function chargeDateFor(month: string, anchor: Date): Date {
  const { year, month: mm } = parseMonth(month)
  const first = new Date(Date.UTC(year, mm - 1, 1))
  const day = Math.min(anchor.getUTCDate(), getDaysInMonth(first))
  return new Date(
    Date.UTC(year, mm - 1, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()),
  )
}

/** The billing month (by charge date) that `at` falls in. */
export function billingMonthAt(at: Date, anchor: Date): string {
  const sameMonth = monthKey(at)
  return at < chargeDateFor(sameMonth, anchor) ? shiftMonth(sameMonth, -1) : sameMonth
}
