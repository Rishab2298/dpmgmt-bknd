import * as XLSX from 'xlsx'
import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { extractWeekFromFilename } from '../detect'

// DOT/Step Van fleet types requiring 5-minute (300s) minimum inspection
const DOT_TYPES = new Set(['step van', 'dot', 'dot step van', 'motorhome'])

function isDotVehicle(fleetType: string): boolean {
  return DOT_TYPES.has(fleetType.toLowerCase().trim())
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDateShort(dateStr: string): string {
  // Format "YYYY-MM-DD" → "Mon 11/23"
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return dateStr
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]
  return `${day} ${d.getMonth() + 1}/${d.getDate()}`
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function colVal(row: Record<string, string>, candidates: string[]): string {
  const normedRow: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) normedRow[norm(k)] = v
  for (const c of candidates) {
    const v = normedRow[norm(c)]
    if (v !== undefined && v !== '') return v
  }
  return ''
}

export function parseDvic(buffer: Buffer, filename: string): ParsedDocumentResult {
  const weekMeta = extractWeekFromFilename(filename)
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { raw: false, defval: '' })

  interface DriverEntry {
    firstName?: string
    lastName?: string
    inspections: Array<{
      date: string
      vehicleId: string
      fleetType: string
      durationSeconds: number
      isRushed: boolean
      isCritical: boolean
      minRequired: number
    }>
  }

  const driverMap = new Map<string, DriverEntry>()

  for (const row of rows) {
    const transporterId = colVal(row, ['transporter_id', 'transporter id', 'driver id', 'da id'])
    if (!transporterId) continue

    const name = colVal(row, ['transporter_name', 'name', 'driver name', 'da name'])
    const nameParts = name.trim().split(/\s+/)
    const firstName = nameParts[0] || undefined
    const lastName = nameParts[nameParts.length - 1] !== nameParts[0] ? nameParts[nameParts.length - 1] : undefined

    const fleetType = colVal(row, ['fleet_type', 'fleet type', 'vehicle type'])
    const durationRaw = colVal(row, ['duration', 'inspection_duration', 'dvic_duration', 'time'])
    const durationSeconds = parseFloat(durationRaw) || 0
    const minRequired = isDotVehicle(fleetType) ? 300 : 90

    const isRushed   = durationSeconds < minRequired && durationSeconds > 0
    const isCritical = durationSeconds < 10 && durationSeconds > 0

    if (!driverMap.has(transporterId)) {
      driverMap.set(transporterId, { firstName, lastName, inspections: [] })
    }
    driverMap.get(transporterId)!.inspections.push({
      date:            colVal(row, ['start_date', 'date', 'inspection_date']),
      vehicleId:       colVal(row, ['vin', 'vehicle', 'vehicle id', 'van']),
      fleetType,
      durationSeconds,
      isRushed,
      isCritical,
      minRequired,
    })
  }

  const drivers: ParsedDriver[] = []
  for (const [transporterId, { firstName, lastName, inspections }] of driverMap) {
    const totalInspections = inspections.length
    const rushedCount   = inspections.filter(i => i.isRushed).length
    const criticalCount = inspections.filter(i => i.isCritical).length
    const compliantCount = totalInspections - rushedCount
    const complianceRate = totalInspections > 0
      ? Math.round((compliantCount / totalInspections) * 1000) / 10
      : 0

    // Build dvicDate1..7 / dvicTime1..7 (up to 7 days)
    const dailyFields: Record<string, unknown> = {}
    inspections.slice(0, 7).forEach((ins, idx) => {
      dailyFields[`dvicDate${idx + 1}`] = formatDateShort(ins.date)
      dailyFields[`dvicTime${idx + 1}`] = formatDuration(ins.durationSeconds)
    })

    drivers.push({
      transporterId,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      metrics: {
        dvicTotalInspections: totalInspections,
        dvicCompliantCount:   compliantCount,
        dvicRushedCount:      rushedCount,
        dvicCriticalCount:    criticalCount,
        dvicComplianceRate:   complianceRate,
        dvicRushedInspections: `${rushedCount}/${totalInspections}`,
        ...dailyFields,
      },
    })
  }

  return {
    docType: 'DVIC',
    drivers,
    metadata: {
      weekNumber: weekMeta?.weekNumber,
      year: weekMeta?.year,
      totalRecords: rows.length,
    },
  }
}
