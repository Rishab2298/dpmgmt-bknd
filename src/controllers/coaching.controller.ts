import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { DEFAULT_METRICS } from '../lib/coaching/seed'

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveDsp(userId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  return emp?.dspId ?? null
}

// ─── Seed coaching rules for a DSP (idempotent) ─────────────────────────────

async function ensureSeeded(dspId: string) {
  const count = await prisma.coachingRule.count({ where: { dspId } })
  if (count > 0) return

  // Create rules with default goals/triggers
  await prisma.coachingRule.createMany({
    data: DEFAULT_METRICS.map(m => ({
      dspId,
      metricKey: m.metricKey,
      category: m.category,
      label: m.label,
      unit: m.unit ?? null,
      goal: m.defaultGoal ?? null,
      trigger: m.defaultTrigger ?? null,
      sortOrder: m.sortOrder,
      enabled: false,
    })),
  })

  // Fetch created rules to get IDs for tips
  const rules = await prisma.coachingRule.findMany({
    where: { dspId },
    select: { id: true, metricKey: true },
  })
  const ruleMap = new Map(rules.map(r => [r.metricKey, r.id]))

  // Create default tips
  const tips: Array<{ ruleId: string; rangeMin: number | null; rangeMax: number | null; message: string; severity: string; sortOrder: number }> = []
  for (const m of DEFAULT_METRICS) {
    if (!m.defaultTips) continue
    const ruleId = ruleMap.get(m.metricKey)
    if (!ruleId) continue
    for (const t of m.defaultTips) {
      tips.push({ ruleId, rangeMin: t.rangeMin, rangeMax: t.rangeMax, message: t.message, severity: t.severity, sortOrder: t.sortOrder })
    }
  }
  if (tips.length > 0) {
    await prisma.coachingTip.createMany({ data: tips })
  }
}

// ─── Load default tips (reset to PDF defaults) ─────────────────────────────

export async function loadDefaults(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  // Delete all existing tips for this DSP
  await prisma.coachingTip.deleteMany({
    where: { rule: { dspId } },
  })

  // Reset goals/triggers and create default tips
  const rules = await prisma.coachingRule.findMany({
    where: { dspId },
    select: { id: true, metricKey: true },
  })
  const ruleMap = new Map(rules.map(r => [r.metricKey, r.id]))

  const tips: Array<{ ruleId: string; rangeMin: number | null; rangeMax: number | null; message: string; severity: string; sortOrder: number }> = []
  for (const m of DEFAULT_METRICS) {
    const ruleId = ruleMap.get(m.metricKey)
    if (!ruleId) continue

    // Reset goal/trigger/unit to defaults
    await prisma.coachingRule.update({
      where: { id: ruleId },
      data: {
        goal: m.defaultGoal ?? null,
        trigger: m.defaultTrigger ?? null,
        unit: m.unit ?? null,
      },
    })

    if (!m.defaultTips) continue
    for (const t of m.defaultTips) {
      tips.push({ ruleId, rangeMin: t.rangeMin, rangeMax: t.rangeMax, message: t.message, severity: t.severity, sortOrder: t.sortOrder })
    }
  }
  if (tips.length > 0) {
    await prisma.coachingTip.createMany({ data: tips })
  }

  // Return updated rules
  const updated = await prisma.coachingRule.findMany({
    where: { dspId },
    include: { tips: { orderBy: { sortOrder: 'asc' } } },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
  })

  res.json({ rules: updated })
}

// ─── List all rules ──────────────────────────────────────────────────────────

export async function listRules(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  await ensureSeeded(dspId)

  const rules = await prisma.coachingRule.findMany({
    where: { dspId },
    include: { tips: { orderBy: { sortOrder: 'asc' } } },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
  })

  res.json({ rules })
}

// ─── Update a rule ───────────────────────────────────────────────────────────

const updateRuleSchema = z.object({
  goal: z.number().nullable().optional(),
  trigger: z.number().nullable().optional(),
  enabled: z.boolean().optional(),
  coachingText: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
})

export async function updateRule(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const parsed = updateRuleSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Invalid request' }); return
  }

  const rule = await prisma.coachingRule.findFirst({
    where: { id: String(req.params.id), dspId },
  })
  if (!rule) { res.status(404).json({ message: 'Rule not found' }); return }

  const updated = await prisma.coachingRule.update({
    where: { id: rule.id },
    data: parsed.data,
    include: { tips: { orderBy: { sortOrder: 'asc' } } },
  })

  res.json({ rule: updated })
}

// ─── Add a tip ───────────────────────────────────────────────────────────────

const addTipSchema = z.object({
  rangeMin: z.number().nullable(),
  rangeMax: z.number().nullable(),
  message: z.string().min(1),
  severity: z.enum(['GREEN', 'YELLOW', 'ORANGE', 'RED']),
})

export async function addTip(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const parsed = addTipSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Invalid request' }); return
  }

  const rule = await prisma.coachingRule.findFirst({
    where: { id: String(req.params.id), dspId },
  })
  if (!rule) { res.status(404).json({ message: 'Rule not found' }); return }

  // Auto-assign sortOrder
  const maxSort = await prisma.coachingTip.aggregate({
    where: { ruleId: rule.id },
    _max: { sortOrder: true },
  })

  const tip = await prisma.coachingTip.create({
    data: {
      ruleId: rule.id,
      rangeMin: parsed.data.rangeMin,
      rangeMax: parsed.data.rangeMax,
      message: parsed.data.message,
      severity: parsed.data.severity,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
  })

  res.status(201).json({ tip })
}

// ─── Update a tip ────────────────────────────────────────────────────────────

const updateTipSchema = z.object({
  rangeMin: z.number().nullable().optional(),
  rangeMax: z.number().nullable().optional(),
  message: z.string().min(1).optional(),
  severity: z.enum(['GREEN', 'YELLOW', 'ORANGE', 'RED']).optional(),
})

export async function updateTip(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const parsed = updateTipSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Invalid request' }); return
  }

  const tip = await prisma.coachingTip.findFirst({
    where: { id: String(req.params.id), rule: { dspId } },
  })
  if (!tip) { res.status(404).json({ message: 'Tip not found' }); return }

  const updated = await prisma.coachingTip.update({
    where: { id: tip.id },
    data: parsed.data,
  })

  res.json({ tip: updated })
}

// ─── Delete a tip ────────────────────────────────────────────────────────────

export async function deleteTip(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const tip = await prisma.coachingTip.findFirst({
    where: { id: String(req.params.id), rule: { dspId } },
  })
  if (!tip) { res.status(404).json({ message: 'Tip not found' }); return }

  await prisma.coachingTip.delete({ where: { id: tip.id } })
  res.status(204).send()
}

// ─── Get per-driver overrides ────────────────────────────────────────────────

export async function getOverrides(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const transporterId = String(req.query.transporterId ?? '')
  if (!transporterId) { res.status(400).json({ message: 'transporterId required' }); return }

  const overrides = await prisma.coachingDriverOverride.findMany({
    where: { rule: { dspId }, transporterId: { equals: transporterId, mode: 'insensitive' } },
    include: { rule: { select: { id: true, metricKey: true, label: true } } },
  })

  res.json({ overrides })
}

// ─── Set per-driver override ─────────────────────────────────────────────────

const setOverrideSchema = z.object({
  goal: z.number().nullable().optional(),
  trigger: z.number().nullable().optional(),
  enabled: z.boolean().nullable().optional(),
})

export async function setOverride(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const parsed = setOverrideSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Invalid request' }); return
  }

  const rule = await prisma.coachingRule.findFirst({
    where: { id: String(req.params.ruleId), dspId },
  })
  if (!rule) { res.status(404).json({ message: 'Rule not found' }); return }

  const transporterId = String(req.params.transporterId)

  const override = await prisma.coachingDriverOverride.upsert({
    where: { ruleId_transporterId: { ruleId: rule.id, transporterId } },
    create: { ruleId: rule.id, transporterId, ...parsed.data },
    update: parsed.data,
  })

  res.json({ override })
}

// ─── Delete per-driver override ──────────────────────────────────────────────

export async function deleteOverride(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const rule = await prisma.coachingRule.findFirst({
    where: { id: String(req.params.ruleId), dspId },
  })
  if (!rule) { res.status(404).json({ message: 'Rule not found' }); return }

  await prisma.coachingDriverOverride.deleteMany({
    where: { ruleId: rule.id, transporterId: String(req.params.transporterId) },
  })

  res.status(204).send()
}
