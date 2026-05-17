import * as XLSX from 'xlsx'

// Parse a CSV or XLSX buffer into an array of row objects (headers as keys)
export function parseSpreadsheetBuffer(buffer: Buffer): Record<string, string>[] {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json<Record<string, string>>(ws, { raw: false, defval: '' })
}

// Normalize a string for fuzzy key matching (lowercase, alphanumeric only)
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Find a value in a row by trying multiple candidate header names
export function col(row: Record<string, string>, candidates: string[]): string {
  const normedRow: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) {
    normedRow[norm(k)] = v
  }
  for (const c of candidates) {
    const v = normedRow[norm(c)]
    if (v !== undefined && v !== '') return v
  }
  return ''
}

// Parse a numeric string (strips %, commas, handles "no data" / "n/a" / "-")
const SKIP = new Set(['no data', 'n/a', '-', 'coming soon', ''])
export function parseNum(raw: string): number | undefined {
  if (!raw) return undefined
  const cleaned = raw.replace(/%/g, '').replace(/,/g, '').trim()
  if (SKIP.has(cleaned.toLowerCase())) return undefined
  const n = parseFloat(cleaned)
  return isNaN(n) ? undefined : n
}

// Split a full name into first/last
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts[parts.length - 1] }
}
