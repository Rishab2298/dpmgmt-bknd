import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { extractWeekFromFilename } from '../detect'
import { parseSpreadsheetBuffer, col, parseNum, splitName } from './utils'

interface WeekEntry {
  week: number
  year: number
  metrics: Record<string, unknown>
}

export function parseTrailingSixWeek(buffer: Buffer, filename: string): ParsedDocumentResult {
  const rows = parseSpreadsheetBuffer(buffer)
  const weekMeta = extractWeekFromFilename(filename)

  // Group rows by driver — each driver appears once per week (up to 6 rows)
  const driverMap = new Map<string, { firstName?: string; lastName?: string; weeks: WeekEntry[] }>()

  for (const row of rows) {
    const transporterId = col(row, [
      'transporter id', 'transporter_id', 'transporterid', 'transporter',
      'driver id', 'driverid', 'employee id', 'employeeid',
    ])
    if (!transporterId) continue

    const name = col(row, ['delivery associate', 'name', 'driver name'])
    const { firstName, lastName } = splitName(name)

    // Parse week from row (e.g. "2025-W48" → week 48, year 2025)
    const weekRaw = col(row, ['week'])
    let weekNum: number | undefined
    let yearNum: number | undefined
    const wm = weekRaw.match(/(\d{4})-W(\d+)/i)
    if (wm) { yearNum = parseInt(wm[1]); weekNum = parseInt(wm[2]) }

    const weekEntry: WeekEntry = {
      week: weekNum ?? weekMeta?.weekNumber ?? 0,
      year: yearNum ?? weekMeta?.year ?? new Date().getFullYear(),
      metrics: {
        overallScore:          parseNum(col(row, ['overall score'])),
        tier:                  col(row, ['tier']) || undefined,
        rank:                  parseNum(col(row, ['rank'])),
        ficoScore:             parseNum(col(row, ['fico score', 'fico'])),
        speedingEventRate:     parseNum(col(row, ['speeding event rate (per trip)', 'speeding event rate', 'speeding'])),
        seatbeltOffRate:       parseNum(col(row, ['seatbelt-off rate (per trip)', 'seatbelt-off rate', 'seatbelt off rate'])),
        distractionsRate:      parseNum(col(row, ['distractions rate (per trip)', 'distractions rate', 'distraction rate'])),
        signalViolationsRate:  parseNum(col(row, ['sign/signal violations rate (per trip)', 'sign/signal violations rate', 'sign signal violations rate'])),
        followingDistanceRate: parseNum(col(row, ['following distance rate (per trip)', 'following distance rate'])),
        cdfDpmo:               parseNum(col(row, ['cdf dpmo', 'cdf'])),
        cedScore:              parseNum(col(row, ['ced score', 'ced'])),
        dcr:                   parseNum(col(row, ['dcr', 'delivery completion rate'])),
        dsbDpmo:               parseNum(col(row, ['dsb dpmo', 'dsb'])),
        pod:                   parseNum(col(row, ['pod', 'photo on delivery'])),
        psb:                   parseNum(col(row, ['psb'])),
        packagesDelivered:     parseNum(col(row, ['packages delivered', 'delivered'])),
        // Tier labels
        ficoTier:              col(row, ['fico tier']) || undefined,
        speedingEventRateTier: col(row, ['speeding event rate tier']) || undefined,
        seatbeltOffRateTier:   col(row, ['seatbelt-off rate tier', 'seatbelt off rate tier']) || undefined,
        distractionsRateTier:  col(row, ['distractions rate tier']) || undefined,
        signalViolationsRateTier: col(row, ['sign/signal violations rate tier']) || undefined,
        followingDistanceRateTier: col(row, ['following distance rate tier']) || undefined,
        cdfDpmoTier:           col(row, ['cdf dpmo tier']) || undefined,
        dcrTier:               col(row, ['dcr tier']) || undefined,
        dsbDpmoTier:           col(row, ['dsb dpmo tier']) || undefined,
        podTier:               col(row, ['pod tier']) || undefined,
        psbTier:               col(row, ['psb tier']) || undefined,
      },
    }

    if (!driverMap.has(transporterId)) {
      driverMap.set(transporterId, { firstName, lastName, weeks: [] })
    }
    driverMap.get(transporterId)!.weeks.push(weekEntry)
  }

  const drivers: ParsedDriver[] = []
  for (const [transporterId, { firstName, lastName, weeks }] of driverMap) {
    drivers.push({
      transporterId,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      metrics: { historicalData: weeks },
    })
  }

  return {
    docType: 'TRAILING_SIX_WEEK',
    drivers,
    metadata: {
      weekNumber: weekMeta?.weekNumber,
      year: weekMeta?.year,
      totalRecords: rows.length,
    },
  }
}
