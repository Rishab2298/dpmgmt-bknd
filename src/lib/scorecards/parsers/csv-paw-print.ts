import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { parseSpreadsheetBuffer, col, parseNum, splitName } from './utils'

export function parsePawPrint(buffer: Buffer, _filename: string): ParsedDocumentResult {
  const rows = parseSpreadsheetBuffer(buffer)

  // Group by driver, storing data per week (e.g. "WK 2" → 2)
  const driverMap = new Map<string, {
    firstName?: string
    lastName?: string
    byWeek: Record<number, { texts: number; stopsWithPawPrints: number; complianceRate: number }>
  }>()

  const availableWeeks = new Set<number>()

  for (const row of rows) {
    const transporterId = col(row, ['transporter id', 'transporter_id', 'driver id', 'employee id'])
    if (!transporterId) continue

    const weekRaw = col(row, ['week'])
    // Skip rolling summary rows
    if (weekRaw.toLowerCase().includes('rolling')) continue

    // Parse "WK 2" → 2
    const wm = weekRaw.match(/\d+/)
    if (!wm) continue
    const weekNum = parseInt(wm[0])
    availableWeeks.add(weekNum)

    const name = col(row, ['transporter name', 'name', 'driver name'])
    const { firstName, lastName } = splitName(name)

    const texts             = parseNum(col(row, ['texts'])) ?? 0
    const stopsWithPawPrints = parseNum(col(row, ['stops w/paw prints', 'stops with paw prints'])) ?? 0
    const complianceRate    = parseNum(col(row, ['%', 'compliance rate', 'compliance %'])) ?? 0

    if (!driverMap.has(transporterId)) {
      driverMap.set(transporterId, { firstName, lastName, byWeek: {} })
    }
    driverMap.get(transporterId)!.byWeek[weekNum] = { texts, stopsWithPawPrints, complianceRate }
  }

  const drivers: ParsedDriver[] = []
  for (const [transporterId, { firstName, lastName, byWeek }] of driverMap) {
    drivers.push({
      transporterId,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      metrics: {
        pawPrintByWeek: byWeek,
        pawPrintAvailableWeeks: Array.from(availableWeeks).sort((a, b) => a - b),
      },
    })
  }

  return {
    docType: 'PAW_PRINT',
    drivers,
    metadata: {
      totalRecords: rows.length,
      availableWeeks: Array.from(availableWeeks).sort((a, b) => a - b),
    },
  }
}
