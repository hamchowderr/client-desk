/** GMA + 12 -> GMA-012 */
export function formatRequestId(code: string, number: number): string {
  return `${code}-${String(number).padStart(3, '0')}`
}

/** "GMA-012" or "gma-12" -> { code: 'GMA', number: 12 } */
export function parseRequestId(ref: string): { code: string; number: number } | null {
  const m = /^([A-Za-z0-9]{2,6})-(\d{1,6})$/.exec(ref.trim())
  return m ? { code: m[1].toUpperCase(), number: Number(m[2]) } : null
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
