import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { parseSpreadsheetBuffer, col, parseNum, splitName } from './utils'

export function parsePpsDaily(buffer: Buffer, _filename: string): ParsedDocumentResult {
  const rows = parseSpreadsheetBuffer(buffer)

  // Aggregate daily records per driver
  const driverMap = new Map<string, {
    firstName?: string
    lastName?: string
    totalEvaluatedStops: number
    totalMissingParkingBrakeStops: number
    totalMissingGearInParkStops: number
    dailyRecords: unknown[]
  }>()

  for (const row of rows) {
    const transporterId = col(row, ['transporter id', 'transporter_id', 'driver id', 'employee id'])
    if (!transporterId) continue

    const name = col(row, ['da name', 'name', 'driver name'])
    const { firstName, lastName } = splitName(name)

    const totalStops         = parseNum(col(row, ['total evaluated stops'])) ?? 0
    const missingBrakeStops  = parseNum(col(row, ['missing parking brake stops'])) ?? 0
    const missingParkStops   = parseNum(col(row, ['missing gear in park stops'])) ?? 0
    const ppsCompliance      = parseNum(col(row, ['pps compliance (%)', 'pps compliance'])) ?? 0

    const dailyRecord = {
      date:              col(row, ['date']),
      week:              col(row, ['week']),
      vin:               col(row, ['vin']),
      ppsCompliancePercent:          ppsCompliance,
      totalEvaluatedStops:           totalStops,
      missingParkingBrakeStops:      missingBrakeStops,
      missingParkingBrakePercent:    parseNum(col(row, ['missing parking brake (%)', 'missing parking brake percent'])),
      missingGearInParkStops:        missingParkStops,
      missingGearInParkPercent:      parseNum(col(row, ['missing gear in park (%)', 'missing gear in park percent'])),
    }

    if (!driverMap.has(transporterId)) {
      driverMap.set(transporterId, {
        firstName, lastName,
        totalEvaluatedStops: 0,
        totalMissingParkingBrakeStops: 0,
        totalMissingGearInParkStops: 0,
        dailyRecords: [],
      })
    }
    const entry = driverMap.get(transporterId)!
    entry.totalEvaluatedStops             += totalStops
    entry.totalMissingParkingBrakeStops   += missingBrakeStops
    entry.totalMissingGearInParkStops     += missingParkStops
    entry.dailyRecords.push(dailyRecord)
  }

  const drivers: ParsedDriver[] = []
  for (const [transporterId, d] of driverMap) {
    const compliancePercent = d.totalEvaluatedStops > 0
      ? ((d.totalEvaluatedStops - d.totalMissingParkingBrakeStops - d.totalMissingGearInParkStops) / d.totalEvaluatedStops) * 100
      : 0

    drivers.push({
      transporterId,
      firstName: d.firstName || undefined,
      lastName: d.lastName || undefined,
      metrics: {
        ppsCompliancePercent: Math.round(compliancePercent * 10) / 10,
        ppsTotalEvaluatedStops:        d.totalEvaluatedStops,
        ppsMissingParkingBrakeStops:   d.totalMissingParkingBrakeStops,
        ppsMissingGearInParkStops:     d.totalMissingGearInParkStops,
        ppsDailyRecords:               d.dailyRecords,
      },
    })
  }

  return {
    docType: 'PPS_DAILY',
    drivers,
    metadata: { totalRecords: rows.length },
  }
}
