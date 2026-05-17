import { PDFParse } from 'pdf-parse'
import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { extractWeekFromFilename } from '../detect'

// Parse a numeric string, returning undefined for "No Data", "Coming Soon", etc.
function num(s: string): number | undefined {
  if (/no data|coming soon|n\/a/i.test(s)) return undefined
  const cleaned = s.replace(/[%,]/g, '').trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? undefined : n
}

// Amazon transporter IDs are 13-14 chars starting with "A" followed by alphanumeric.
// Examples: A3AHESB408LBV7, ALU291O05LVCP, AKV84IDNM9MXS
const TRANSPORTER_ID_PATTERN = /^A[A-Z0-9]{5,15}$/

// The DSP Scorecard PDF table has these columns (from actual Cortex PDFs):
//   # | Name | Transporter ID | Delivered | Fico Score | Seatbelt Off Rate |
//   Speeding Event Rate | Distractions Rate | Following Distance Rate |
//   Sign/Signal Violations Rate | CDF DPMO | CED | DCR | DSB | POD |
//   PSB | DSB Count | POD Opps.
//
// Each line starts with a row number, then first/last name, then the transporter ID,
// then numeric/text metric values. "No Data" appears for unavailable metrics.

export async function parseDspScorecard(buffer: Buffer, filename: string): Promise<ParsedDocumentResult> {
  const weekMeta = extractWeekFromFilename(filename)
  const drivers: ParsedDriver[] = []

  try {
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    const lines = result.text.split('\n').map((l: string) => l.trim()).filter(Boolean)

    for (const line of lines) {
      const tokens = line.split(/\s+/)

      // Find the transporter ID token (starts with A, 6-16 alphanumeric chars)
      const idIdx = tokens.findIndex((t: string) => TRANSPORTER_ID_PATTERN.test(t))
      if (idIdx < 0) continue

      const transporterId = tokens[idIdx]

      // Everything before the transporter ID is rank number + name
      const beforeId = tokens.slice(0, idIdx)

      // First token should be the rank number (skip it for name extraction)
      const rankNum = parseInt(beforeId[0])
      const nameParts = !isNaN(rankNum) ? beforeId.slice(1) : beforeId
      if (nameParts.length === 0) continue

      const fullName = nameParts.join(' ').trim()
      const nameArr = fullName.split(/\s+/)
      const firstName = nameArr[0] || undefined
      const lastName = nameArr.length > 1 ? nameArr[nameArr.length - 1] : undefined

      // Everything after the transporter ID = metric values
      // These include "No", "Data", "Coming", "Soon" as separate tokens when split by space
      // Rejoin them first, then parse
      const afterId = tokens.slice(idIdx + 1).join(' ')

      // Replace "No Data" and "Coming Soon" with a placeholder, then split again
      const cleaned = afterId
        .replace(/No\s+Data/gi, '_NODATA_')
        .replace(/Coming\s+Soon/gi, '_NODATA_')
      const metricTokens = cleaned.split(/\s+/)

      // Map tokens to metrics in column order:
      // [0] Delivered, [1] Fico Score, [2] Seatbelt Off Rate, [3] Speeding Event Rate,
      // [4] Distractions Rate, [5] Following Distance Rate, [6] Sign/Signal Violations Rate,
      // [7] CDF DPMO, [8] CED, [9] DCR, [10] DSB, [11] POD, [12] PSB, [13] DSB Count, [14] POD Opps.
      function getMetric(idx: number): number | undefined {
        const t = metricTokens[idx]
        if (!t || t === '_NODATA_') return undefined
        return num(t)
      }

      const metrics: Record<string, unknown> = {}
      const packagesDelivered = getMetric(0)
      if (packagesDelivered !== undefined) metrics.packagesDelivered = packagesDelivered
      const ficoScore = getMetric(1)
      if (ficoScore !== undefined) metrics.ficoScore = ficoScore
      const seatbeltOffRate = getMetric(2)
      if (seatbeltOffRate !== undefined) metrics.seatbeltOffRate = seatbeltOffRate
      const speedingEventRate = getMetric(3)
      if (speedingEventRate !== undefined) metrics.speedingEventRate = speedingEventRate
      const distractionsRate = getMetric(4)
      if (distractionsRate !== undefined) metrics.distractionsRate = distractionsRate
      const followingDistanceRate = getMetric(5)
      if (followingDistanceRate !== undefined) metrics.followingDistanceRate = followingDistanceRate
      const signalViolationsRate = getMetric(6)
      if (signalViolationsRate !== undefined) metrics.signalViolationsRate = signalViolationsRate
      const cdfDpmo = getMetric(7)
      if (cdfDpmo !== undefined) metrics.cdfDpmo = cdfDpmo
      const customerEscalationDefect = getMetric(8)
      if (customerEscalationDefect !== undefined) metrics.customerEscalationDefect = customerEscalationDefect
      const deliveryCompletionRate = getMetric(9)
      if (deliveryCompletionRate !== undefined) metrics.deliveryCompletionRate = deliveryCompletionRate
      const deliverySuccessBehaviors = getMetric(10)
      if (deliverySuccessBehaviors !== undefined) metrics.deliverySuccessBehaviors = deliverySuccessBehaviors
      const podAcceptanceRate = getMetric(11)
      if (podAcceptanceRate !== undefined) metrics.podAcceptanceRate = podAcceptanceRate
      // PSB = getMetric(12) — skip for now (Coming Soon in most PDFs)
      // DSB Count = getMetric(13)
      // POD Opps = getMetric(14)

      // Validate: must have at least a transporter ID and a name
      if (transporterId && firstName) {
        drivers.push({ transporterId, firstName, lastName, metrics })
      }
    }
  } catch (err) {
    console.error('[parseDspScorecard] PDF parse error:', err)
  }

  return {
    docType: 'DSP_SCORECARD',
    drivers,
    metadata: {
      weekNumber: weekMeta?.weekNumber,
      year: weekMeta?.year,
      totalRecords: drivers.length,
    },
  }
}
