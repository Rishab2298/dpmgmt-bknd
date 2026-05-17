import { prisma } from '../prisma'

/**
 * Async coaching evaluation — called fire-and-forget after saveScorecard.
 *
 * For each driver × each enabled rule, finds the matching tip (by range)
 * and creates an Announcement record if a tip matches.
 */
export async function evaluateCoaching(
  dspId: string,
  weekId: string,
  drivers: Array<{
    transporterId: string
    firstName?: string
    lastName?: string
    metrics: Record<string, unknown>
  }>,
) {
  // 1. Fetch all enabled coaching rules with tips
  const rules = await prisma.coachingRule.findMany({
    where: { dspId, enabled: true },
    include: { tips: { orderBy: { sortOrder: 'asc' } } },
  })

  if (rules.length === 0) return

  // 2. Fetch per-driver overrides
  const overrides = await prisma.coachingDriverOverride.findMany({
    where: { rule: { dspId } },
  })
  const overrideMap = new Map<string, typeof overrides[number]>()
  for (const o of overrides) {
    overrideMap.set(`${o.ruleId}:${o.transporterId.toUpperCase()}`, o)
  }

  // 3. Delete existing announcements for this week (idempotent re-save)
  await prisma.announcement.deleteMany({ where: { weekId } })

  // 4. Evaluate each driver × each rule
  const announcements: Array<{
    dspId: string
    transporterId: string
    weekId: string
    metricKey: string
    metricValue: number
    title: string
    message: string
    severity: string
  }> = []

  for (const driver of drivers) {
    const tid = driver.transporterId.toUpperCase()

    for (const rule of rules) {
      // Check per-driver override
      const override = overrideMap.get(`${rule.id}:${tid}`)
      const isEnabled = override?.enabled ?? rule.enabled
      if (!isEnabled) continue

      // Get metric value
      const raw = driver.metrics[rule.metricKey]
      if (raw == null) continue
      const value = Number(raw)
      if (isNaN(value)) continue

      // Find matching tip by range
      const tip = findMatchingTip(rule.tips, value)
      if (!tip) continue

      announcements.push({
        dspId,
        transporterId: driver.transporterId,
        weekId,
        metricKey: rule.metricKey,
        metricValue: value,
        title: `${rule.label}: ${formatValue(value, rule.metricKey)}`,
        message: tip.message,
        severity: tip.severity,
      })
    }
  }

  if (announcements.length > 0) {
    await prisma.announcement.createMany({ data: announcements })
    console.log(`[coaching] Created ${announcements.length} announcements for week ${weekId}`)
  }
}

/**
 * Find the matching tip for a metric value using explicit ranges.
 *
 * Each tip defines a [rangeMin, rangeMax] range. Null bounds mean open-ended.
 * Tips are ordered by sortOrder — first match wins.
 */
function findMatchingTip(
  tips: Array<{ rangeMin: number | null; rangeMax: number | null; message: string; severity: string }>,
  value: number,
): { message: string; severity: string } | null {
  if (tips.length === 0) return null

  for (const tip of tips) {
    const aboveMin = tip.rangeMin == null || value >= tip.rangeMin
    const belowMax = tip.rangeMax == null || value <= tip.rangeMax
    if (aboveMin && belowMax) {
      return { message: tip.message, severity: tip.severity }
    }
  }

  return null
}

function formatValue(value: number, metricKey: string): string {
  if (metricKey.includes('Rate') || metricKey.includes('Compliance') || metricKey.includes('Acceptance')) {
    return `${value.toFixed(1)}%`
  }
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1)
}
