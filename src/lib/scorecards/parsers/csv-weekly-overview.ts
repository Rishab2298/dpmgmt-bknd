import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { extractWeekFromFilename } from '../detect'
import { parseSpreadsheetBuffer, col, parseNum, splitName } from './utils'

export function parseWeeklyOverview(buffer: Buffer, filename: string): ParsedDocumentResult {
  const rows = parseSpreadsheetBuffer(buffer)
  const weekMeta = extractWeekFromFilename(filename)
  const drivers: ParsedDriver[] = []

  for (const row of rows) {
    const transporterId = col(row, [
      'transporter id', 'transporter_id', 'transporterid', 'transporter',
      'driver id', 'driverid', 'employee id', 'employeeid',
    ])
    if (!transporterId) continue

    const name = col(row, ['name', 'driver name', 'delivery associate'])
    const { firstName, lastName } = splitName(name)

    drivers.push({
      transporterId,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      metrics: {
        overallStanding: col(row, ['overall standing']) || undefined,
        tier:            col(row, ['tier']) || undefined,
        rank:            parseNum(col(row, ['rank'])),
        driverSafety:    parseNum(col(row, ['safety', 'driver safety'])),
        ficoScore:       parseNum(col(row, ['fico', 'fico score'])),
        seatbeltOffRate: parseNum(col(row, ['seatbelt off rate', 'seatbelt'])),
        speedingEventRate:   parseNum(col(row, ['speeding event rate', 'speeding'])),
        distractionRate:     parseNum(col(row, ['distraction rate', 'distractions'])),
        followingDistanceRate: parseNum(col(row, ['following distance', 'following distance rate'])),
        signSignalViolations:  parseNum(col(row, ['sign/signal violations', 'sign signal violations'])),
        cdfDpmo:         parseNum(col(row, ['cdf dpmo', 'cdf'])),
        ced:             parseNum(col(row, ['ced', 'customer escalation'])),
        dcr:             parseNum(col(row, ['dcr', 'delivery completion rate'])),
        dsb:             parseNum(col(row, ['dsb', 'delivery success behaviors'])),
        pod:             parseNum(col(row, ['pod', 'photo on delivery'])),
        psb:             parseNum(col(row, ['psb'])),
        packagesDelivered: parseNum(col(row, ['packages delivered', 'delivered'])),
      },
    })
  }

  return {
    docType: 'WEEKLY_OVERVIEW',
    drivers,
    metadata: {
      weekNumber: weekMeta?.weekNumber,
      year: weekMeta?.year,
      totalRecords: drivers.length,
    },
  }
}
