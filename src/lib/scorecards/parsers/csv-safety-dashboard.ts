import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { extractWeekFromFilename } from '../detect'
import { parseSpreadsheetBuffer, col } from './utils'

const VALID_METRIC_TYPES = new Set(['Distraction', 'Sign Signal', 'Speeding', 'Following Distance', 'Seatbelt'])

interface SafetyEvent {
  eventId: string
  date: string
  dateTime: string
  metricSubtype: string
  programImpact: string
  source: string
  videoLink: string
  reviewDetails: string
  vin: string
}

export function parseSafetyDashboard(buffer: Buffer, filename: string): ParsedDocumentResult {
  const rows = parseSpreadsheetBuffer(buffer)
  const weekMeta = extractWeekFromFilename(filename)

  const driverMap = new Map<string, {
    firstName?: string
    lastName?: string
    events: Record<string, SafetyEvent[]>
  }>()

  for (const row of rows) {
    const transporterId = col(row, ['transporter id', 'transporter_id', 'driver id'])
    if (!transporterId) continue

    const metricType = col(row, ['metric type'])
    if (!VALID_METRIC_TYPES.has(metricType)) continue

    const name = col(row, ['delivery associate', 'name', 'driver name'])
    const firstName = name.split(/\s+/)[0] || undefined
    const lastName  = name.split(/\s+/).slice(-1)[0] || undefined

    if (!driverMap.has(transporterId)) {
      driverMap.set(transporterId, {
        firstName, lastName,
        events: Object.fromEntries([...VALID_METRIC_TYPES].map(t => [t, []])),
      })
    }

    const event: SafetyEvent = {
      eventId:       col(row, ['event id']),
      date:          col(row, ['date']),
      dateTime:      col(row, ['date time (pdt)', 'date time (pst)', 'date time']),
      metricSubtype: col(row, ['metric subtype']),
      programImpact: col(row, ['program impact']),
      source:        col(row, ['source']),
      videoLink:     col(row, ['video link']),
      reviewDetails: col(row, ['review details']),
      vin:           col(row, ['vin']),
    }

    driverMap.get(transporterId)!.events[metricType].push(event)
  }

  const drivers: ParsedDriver[] = []
  for (const [transporterId, { firstName, lastName, events }] of driverMap) {
    const totalEvents = Object.values(events).reduce((s, arr) => s + arr.length, 0)
    drivers.push({
      transporterId,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      metrics: {
        safetyEvents: events,
        totalSafetyEvents: totalEvents,
      },
    })
  }

  return {
    docType: 'SAFETY_DASHBOARD',
    drivers,
    metadata: {
      weekNumber: weekMeta?.weekNumber,
      year: weekMeta?.year,
      totalRecords: rows.length,
    },
  }
}
