import type { ParsedDocumentResult, MergedDriver } from './types'

// ─── Constants ───────────────────────────────────────────────────────────────

// Safety event metrics that come from the DSP Scorecard PDF. When the Weekly
// Overview CSV also has these same metrics, the CSV values are stored with a
// `_csv` suffix so both versions are preserved (PDF values are source of truth).
const SAFETY_METRICS_FROM_PDF = new Set([
  'seatbeltOffRate',
  'speedingEventRate',
  'distractionsRate',
  'followingDistanceRate',
  'signalViolationsRate',
  'ficoScore',
])

// Tier ordering (lower = better). Matches DiveMetric's tierOrder constant.
const TIER_ORDER: Record<string, number> = {
  Platinum: 0, Fantastic: 0,
  Gold: 1, Great: 1,
  Silver: 2, Fair: 2,
  Bronze: 3,
  Poor: 4,
}

// Keys that are preserved as nested objects during flattening.
const PRESERVE_NESTED = new Set(['safetyEvents', 'podRejectsBreakdown', 'feedbackCategories'])

// ─── Quality Group (6 levels, 0 = best) ──────────────────────────────────────

function getQualityGroup(metrics: Record<string, unknown>): number {
  const dpmo = Number(metrics.cdfDpmo) || 0
  const dcr  = Number(metrics.deliveryCompletionRate ?? metrics.dcr) || 0
  const pod  = Number(metrics.podAcceptanceRate ?? metrics.pod) || 0

  if (pod < 99.7) return 5                                     // Below POD threshold
  if (dpmo === 0 && dcr >= 100 && pod >= 100) return 0         // Perfect
  if (dpmo === 0 && dcr >= 99.8) return 1                      // Zero defects
  if (dpmo > 0 && dpmo <= 1000 && dcr >= 100 && pod >= 100) return 2 // Excellent
  if (dpmo === 0) return 3                                     // Zero defects, DCR < 99.8
  return 4                                                     // Default
}

// ─── Flatten driver metrics ──────────────────────────────────────────────────
// Converts nested objects to flat keys (e.g. feedbackCategories.accessibility →
// feedbackCategories_accessibility). Historical/week arrays get special handling
// (historicalData[{week:1,metrics:{dcr:99}}] → historicalData_week1_dcr).
// safetyEvents is preserved as-is (not flattened).

function flattenObject(
  obj: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  const flat: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}_${key}` : key

    // Preserve certain nested objects as-is
    if (!prefix && PRESERVE_NESTED.has(key)) {
      flat[key] = value
      continue
    }

    if (value === null || value === undefined) {
      flat[newKey] = value
      continue
    }

    if (Array.isArray(value)) {
      if (key === 'historicalData' || key === 'weeklyData') {
        // Week-based arrays: flatten with week number key
        for (const item of value) {
          if (typeof item !== 'object' || item === null) continue
          const entry = item as Record<string, unknown>
          const weekKey = entry.week != null ? `week${entry.week}` : `w${value.indexOf(item)}`

          if (entry.metrics && typeof entry.metrics === 'object') {
            for (const [mk, mv] of Object.entries(entry.metrics as Record<string, unknown>)) {
              flat[`${newKey}_${weekKey}_${mk}`] = mv
            }
          }
          if (entry.week != null) flat[`${newKey}_${weekKey}_weekNum`] = entry.week
          if (entry.year != null) flat[`${newKey}_${weekKey}_year`] = entry.year
        }
      } else {
        // Other arrays: flatten each element with index
        for (let i = 0; i < value.length; i++) {
          const item = value[i]
          if (typeof item === 'object' && item !== null) {
            Object.assign(flat, flattenObject(item as Record<string, unknown>, `${newKey}_${i}`))
          } else {
            flat[`${newKey}_${i}`] = item
          }
        }
      }
      continue
    }

    if (typeof value === 'object') {
      Object.assign(flat, flattenObject(value as Record<string, unknown>, newKey))
      continue
    }

    flat[newKey] = value
  }

  return flat
}

// ─── Merge all parsed documents ──────────────────────────────────────────────
// Matches DiveMetric's mergeResultsToFlatJson() logic:
//   1. Seed driver list from DSP Scorecard PDF (source of truth)
//   2. Merge Weekly Overview CSV (safety metrics get _csv suffix if PDF already set)
//   3. Merge all other documents (only enrich existing drivers)
//   4. Flatten metrics
//   5. Rank by tier → qualityGroup → DPMO → DCR → DVIC → packages
//   6. Calculate score (0–100 linear scale)

export function mergeDocuments(results: ParsedDocumentResult[]): MergedDriver[] {
  const scorecardResult = results.find(r => r.docType === 'DSP_SCORECARD')
  const weeklyOverview  = results.find(r => r.docType === 'WEEKLY_OVERVIEW')

  // ── Step 1: Seed driver map from scorecard PDF (or weekly overview fallback)
  const driverMap = new Map<string, MergedDriver>()

  const seedSource = scorecardResult ?? weeklyOverview
  if (seedSource) {
    for (const d of seedSource.drivers) {
      driverMap.set(d.transporterId.toUpperCase(), {
        transporterId: d.transporterId,
        firstName:     d.firstName,
        lastName:      d.lastName,
        metrics:       { ...d.metrics },
      })
    }
  }

  // ── Step 2: Merge Weekly Overview CSV into scorecard-seeded drivers
  if (scorecardResult && weeklyOverview) {
    for (const d of weeklyOverview.drivers) {
      const key = d.transporterId.toUpperCase()
      const existing = driverMap.get(key)
      if (!existing) continue

      for (const [k, v] of Object.entries(d.metrics)) {
        if (SAFETY_METRICS_FROM_PDF.has(k) && k in existing.metrics) {
          // PDF value is source of truth — store CSV value with _csv suffix
          existing.metrics[`${k}_csv`] = v
        } else if (!(k in existing.metrics)) {
          existing.metrics[k] = v
        }
      }

      // Carry over name if missing
      if (!existing.firstName && d.firstName) existing.firstName = d.firstName
      if (!existing.lastName  && d.lastName)  existing.lastName  = d.lastName
    }
  }

  // ── Step 3: Merge all other document types with doc-type-specific handlers
  // Matches DiveMetric's mergeResultsToFlatJson() — each doc type has specific
  // field mappings and key normalization for frontend compatibility.
  const otherResults = results.filter(
    r => r.docType !== 'DSP_SCORECARD' && r.docType !== 'WEEKLY_OVERVIEW'
  )

  // Determine target week for Paw Print week selection
  const targetWeekNumber = scorecardResult?.metadata?.weekNumber
    ?? weeklyOverview?.metadata?.weekNumber

  for (const result of otherResults) {
    for (const d of result.drivers) {
      const key = d.transporterId.toUpperCase()
      const existing = driverMap.get(key)
      if (!existing) continue // skip drivers not in source of truth

      // Carry over name if missing
      if (!existing.firstName && d.firstName) existing.firstName = d.firstName
      if (!existing.lastName  && d.lastName)  existing.lastName  = d.lastName

      switch (result.docType) {
        case 'PAW_PRINT': {
          // Select the correct week's data and extract flat metrics
          const byWeek = d.metrics.pawPrintByWeek as Record<number, { texts: number; stopsWithPawPrints: number; complianceRate: number }> | undefined
          if (!byWeek) break

          const availableWeeks = d.metrics.pawPrintAvailableWeeks as number[] | undefined
          const weekKey = targetWeekNumber
            ?? (availableWeeks?.length ? Math.max(...availableWeeks) : undefined)

          if (weekKey != null && byWeek[weekKey]) {
            const wd = byWeek[weekKey]
            existing.metrics.pawPrintSent = wd.texts
            existing.metrics.pawPrintTotal = wd.stopsWithPawPrints
            existing.metrics.pawPrintComplianceRate = wd.complianceRate
          }
          break
        }

        case 'DVIC': {
          // Merge all DVIC metrics
          for (const [k, v] of Object.entries(d.metrics)) {
            if (!(k in existing.metrics)) {
              existing.metrics[k] = v
            }
          }
          // Add frontend-expected aliases (numeric values for display + ranking)
          existing.metrics.rushedInspections = d.metrics.dvicRushedCount
          existing.metrics.totalInspections = d.metrics.dvicTotalInspections
          existing.metrics.criticalInspections = d.metrics.dvicCriticalCount
          break
        }

        case 'CUSTOMER_FEEDBACK': {
          // Merge feedback categories and total
          for (const [k, v] of Object.entries(d.metrics)) {
            if (!(k in existing.metrics)) {
              existing.metrics[k] = v
            }
          }
          // Add frontend-expected alias
          existing.metrics.totalFeedback = d.metrics.totalNegativeFeedback
          break
        }

        case 'PPS_DAILY': {
          // Merge PPS metrics (skip raw daily records)
          for (const [k, v] of Object.entries(d.metrics)) {
            if (k === 'ppsDailyRecords') continue
            if (!(k in existing.metrics)) {
              existing.metrics[k] = v
            }
          }
          // Add frontend-expected aliases
          existing.metrics.ppsTotalStops = d.metrics.ppsTotalEvaluatedStops
          const brake = Number(d.metrics.ppsMissingParkingBrakeStops) || 0
          const gear = Number(d.metrics.ppsMissingGearInParkStops) || 0
          existing.metrics.ppsMissingStops = brake + gear
          break
        }

        default: {
          // Generic merge for SAFETY_DASHBOARD, TRAILING_SIX_WEEK, POD_DETAILS, etc.
          for (const [k, v] of Object.entries(d.metrics)) {
            if (!(k in existing.metrics)) {
              existing.metrics[k] = v
            }
          }
          break
        }
      }
    }
  }

  // ── Step 4: Flatten metrics for each driver
  for (const driver of driverMap.values()) {
    driver.metrics = flattenObject(driver.metrics)
  }

  // ── Step 5: Rank — tier → qualityGroup → DPMO → DCR → DVIC → packages
  const drivers = Array.from(driverMap.values())

  const ranked = drivers
    .map(d => {
      const m = d.metrics
      const tierStr = String(m.overallStanding ?? m.tier ?? '').trim()
      return {
        driver: d,
        tier: TIER_ORDER[tierStr] ?? 5,
        qualityGroup: getQualityGroup(m),
        dpmo: Number(m.cdfDpmo) || 0,
        dcr: Number(m.deliveryCompletionRate ?? m.dcr) || 0,
        dvic: Number(m.rushedInspections ?? m.dvicRushed) || 0,
        packages: Number(m.packagesDelivered) || 0,
      }
    })
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      if (a.qualityGroup !== b.qualityGroup) return a.qualityGroup - b.qualityGroup
      // DPMO tiebreaker only for quality groups 2 and 4
      if ((a.qualityGroup === 2 || a.qualityGroup === 4) && a.dpmo !== b.dpmo) {
        return a.dpmo - b.dpmo
      }
      if (b.dcr !== a.dcr) return b.dcr - a.dcr
      if (a.dvic !== b.dvic) return a.dvic - b.dvic
      return b.packages - a.packages
    })

  // ── Step 6: Assign rank + score
  const rankedCount = ranked.length

  return ranked.map(({ driver }, idx) => {
    const rank = idx + 1
    const score = rankedCount > 1
      ? Math.round((100 - ((rank - 1) / (rankedCount - 1) * 100)) * 100) / 100
      : 100

    return { ...driver, rank, score, rankedCount }
  })
}
