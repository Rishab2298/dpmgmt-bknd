import { PDFParse } from 'pdf-parse'
import type { ParsedDocumentResult, ParsedDriver } from '../types'
import { extractWeekFromFilename } from '../detect'

function num(s: string): number | undefined {
  if (/no data|coming soon|n\/a/i.test(s)) return undefined
  const n = parseFloat(s.replace(/[%,]/g, '').trim())
  return isNaN(n) ? undefined : n
}

// The POD Details PDF columns (in order after name + transporter ID):
//   POD Opportunities | POD Success | POD Bypass | POD Rejects |
//   Blurry Photo | Human In Picture | No Package Detected | Package In Car |
//   Package In Hand | Package Not Clearly Visible | Package Too Close |
//   Photo Too Dark | Other

export async function parsePodDetails(buffer: Buffer, filename: string): Promise<ParsedDocumentResult> {
  const weekMeta = extractWeekFromFilename(filename)
  const drivers: ParsedDriver[] = []

  try {
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    const lines = result.text.split('\n').map((l: string) => l.trim()).filter(Boolean)

    const TRANSPORTER_ID_PATTERN = /^A[A-Z0-9]{5,15}$/

    for (const line of lines) {
      const tokens = line.split(/\s+/)
      const idIdx = tokens.findIndex((t: string) => TRANSPORTER_ID_PATTERN.test(t))
      if (idIdx <= 0) continue

      const transporterId = tokens[idIdx]
      const nameParts = tokens.slice(0, idIdx)
      const fullName = nameParts.join(' ').trim()
      const nameArr = fullName.split(/\s+/)
      const firstName = nameArr[0] || undefined
      const lastName = nameArr.length > 1 ? nameArr[nameArr.length - 1] : undefined

      const metricTokens = tokens.slice(idIdx + 1) as string[]
      const nums = metricTokens.map((t: string) => num(t)).filter((v): v is number => v !== undefined)

      const podOpportunities = nums[0]
      const podSuccess       = nums[1]
      const podBypass        = nums[2]
      const podRejects       = nums[3]
      const podQualityScore  = (podOpportunities && podSuccess != null)
        ? Math.round((podSuccess / podOpportunities) * 1000) / 10
        : undefined

      const metrics: Record<string, unknown> = {
        podOpportunities,
        podSuccess,
        podBypass,
        podRejects,
        podQualityScore,
        podRejectsBreakdown: {
          blurryPhoto:             nums[4],
          humanInPicture:          nums[5],
          noPackageDetected:       nums[6],
          packageInCar:            nums[7],
          packageInHand:           nums[8],
          packageNotClearlyVisible: nums[9],
          packageTooClose:         nums[10],
          photoTooDark:            nums[11],
          other:                   nums[12],
        },
      }

      if (transporterId && firstName) {
        drivers.push({ transporterId, firstName, lastName, metrics })
      }
    }
  } catch (err) {
    console.error('[parsePodDetails] PDF parse error:', err)
  }

  return {
    docType: 'POD_DETAILS',
    drivers,
    metadata: {
      weekNumber: weekMeta?.weekNumber,
      year: weekMeta?.year,
      totalRecords: drivers.length,
    },
  }
}
