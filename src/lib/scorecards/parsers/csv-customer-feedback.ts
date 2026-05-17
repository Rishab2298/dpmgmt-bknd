import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { extractWeekFromFilename } from '../detect'
import { parseSpreadsheetBuffer, col, splitName } from './utils'

const CATEGORIES = [
  { key: 'mishandledPackage',          header: 'da mishandled package',              displayName: 'Mishandled Package' },
  { key: 'unprofessional',             header: 'da was unprofessional',               displayName: 'Unprofessional' },
  { key: 'didNotFollowInstructions',   header: 'da did not follow my delivery instructions', displayName: 'Did Not Follow Instructions' },
  { key: 'deliveredToWrongAddress',    header: 'delivered to wrong address',          displayName: 'Delivered to Wrong Address' },
  { key: 'neverReceived',              header: 'never received delivery',             displayName: 'Never Received Delivery' },
  { key: 'receivedWrongItem',          header: 'received wrong item',                 displayName: 'Received Wrong Item' },
]

export function parseCustomerFeedback(buffer: Buffer, filename: string): ParsedDocumentResult {
  const rows = parseSpreadsheetBuffer(buffer)
  const weekMeta = extractWeekFromFilename(filename)

  // Group incidents by driver
  const driverMap = new Map<string, {
    firstName?: string
    lastName?: string
    categories: Record<string, { count: number; items: unknown[] }>
  }>()

  for (const row of rows) {
    const transporterId = col(row, ['delivery associate', 'transporter id', 'driver id', 'employee id'])
    if (!transporterId) continue

    const name = col(row, ['delivery associate name', 'name', 'driver name'])
    const { firstName, lastName } = splitName(name)

    if (!driverMap.has(transporterId)) {
      const cats: Record<string, { count: number; items: unknown[] }> = {}
      for (const c of CATEGORIES) cats[c.key] = { count: 0, items: [] }
      driverMap.set(transporterId, { firstName, lastName, categories: cats })
    }

    const entry = driverMap.get(transporterId)!

    for (const cat of CATEGORIES) {
      const val = col(row, [cat.header])
      if (val === '1' || val === 'true' || val === 'yes') {
        entry.categories[cat.key].count++
        entry.categories[cat.key].items.push({
          feedbackDetails: col(row, ['feedback details']),
          trackingId:      col(row, ['tracking id']),
          deliveryDate:    col(row, ['delivery date']),
        })
      }
    }
  }

  const drivers: ParsedDriver[] = []
  for (const [transporterId, { firstName, lastName, categories }] of driverMap) {
    const totalFeedback = Object.values(categories).reduce((s, c) => s + c.count, 0)
    if (totalFeedback === 0) continue

    const enrichedCats: Record<string, unknown> = {}
    for (const cat of CATEGORIES) {
      enrichedCats[cat.key] = { ...categories[cat.key], displayName: cat.displayName }
    }

    drivers.push({
      transporterId,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      metrics: { feedbackCategories: enrichedCats, totalNegativeFeedback: totalFeedback },
    })
  }

  return {
    docType: 'CUSTOMER_FEEDBACK',
    drivers,
    metadata: {
      weekNumber: weekMeta?.weekNumber,
      year: weekMeta?.year,
      totalRecords: rows.length,
    },
  }
}
