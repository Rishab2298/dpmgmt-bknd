import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getCallerEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { id: true, dspId: true },
  })
}

/** Normalise weekStart to the Sunday of that week (YYYY-MM-DD).
 *  Uses noon to avoid UTC-offset issues where midnight local ≠ midnight UTC. */
function toWeekSunday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() - d.getDay())
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const DayCountsSchema = z.object({
  shiftTypeId: z.string().min(1),
  sun: z.number().int().min(0).max(9999),
  mon: z.number().int().min(0).max(9999),
  tue: z.number().int().min(0).max(9999),
  wed: z.number().int().min(0).max(9999),
  thu: z.number().int().min(0).max(9999),
  fri: z.number().int().min(0).max(9999),
  sat: z.number().int().min(0).max(9999),
})

const SaveSchema = z.object({
  stationId: z.string().min(1),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD'),
  commitments: z.array(DayCountsSchema),
})

const CopyWeekSchema = z.object({
  stationId: z.string().min(1),
  fromWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fromWeekStart must be YYYY-MM-DD'),
  toWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'toWeekStart must be YYYY-MM-DD'),
})

// ─── GET /api/routes/commitments ──────────────────────────────────────────────

export async function getCommitments(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const { stationId, weekStart } = req.query as Record<string, string>

  if (!stationId || !weekStart) {
    res.status(400).json({ message: 'stationId and weekStart are required' })
    return
  }

  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ message: 'No DSP found' }); return }

  const normWeekStart = toWeekSunday(weekStart)

  const [shiftTypes, commitments] = await Promise.all([
    prisma.shiftType.findMany({
      where: { stationId },
      select: {
        id: true,
        name: true,
        color: true,
        vehicleGroupId: true,
        vehicleGroup: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.routeCommitment.findMany({
      where: { stationId, weekStart: normWeekStart },
      select: {
        id: true,
        shiftTypeId: true,
        sun: true, mon: true, tue: true, wed: true,
        thu: true, fri: true, sat: true,
      },
    }),
  ])

  res.json({
    shiftTypes: shiftTypes.map((st) => ({
      id: st.id,
      name: st.name,
      color: st.color,
      vehicleGroupId: st.vehicleGroupId,
      vehicleGroupName: st.vehicleGroup?.name ?? null,
    })),
    commitments,
    weekStart: normWeekStart,
  })
}

// ─── POST /api/routes/commitments/save ───────────────────────────────────────

export async function saveCommitments(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const parsed = SaveSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid input' })
    return
  }

  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ message: 'No DSP found' }); return }

  const { stationId, weekStart, commitments } = parsed.data
  const normWeekStart = toWeekSunday(weekStart)

  // Verify station belongs to this DSP
  const station = await prisma.station.findUnique({ where: { id: stationId } })
  if (!station || station.dspId !== me.dspId) {
    res.status(403).json({ message: 'Station not found' })
    return
  }

  const upserts = commitments.map((c) =>
    prisma.routeCommitment.upsert({
      where: { stationId_shiftTypeId_weekStart: { stationId, shiftTypeId: c.shiftTypeId, weekStart: normWeekStart } },
      create: {
        dspId: me.dspId!,
        stationId,
        shiftTypeId: c.shiftTypeId,
        weekStart: normWeekStart,
        sun: c.sun, mon: c.mon, tue: c.tue, wed: c.wed,
        thu: c.thu, fri: c.fri, sat: c.sat,
      },
      update: {
        sun: c.sun, mon: c.mon, tue: c.tue, wed: c.wed,
        thu: c.thu, fri: c.fri, sat: c.sat,
      },
    })
  )

  const saved = await prisma.$transaction(upserts)

  res.json({ commitments: saved })
}

// ─── POST /api/routes/commitments/copy-week ───────────────────────────────────

export async function copyWeek(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const parsed = CopyWeekSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid input' })
    return
  }

  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ message: 'No DSP found' }); return }

  const { stationId, fromWeekStart, toWeekStart } = parsed.data
  const normFrom = toWeekSunday(fromWeekStart)
  const normTo   = toWeekSunday(toWeekStart)

  if (normFrom === normTo) {
    res.status(400).json({ message: 'fromWeekStart and toWeekStart must be different weeks' })
    return
  }

  // Verify station belongs to this DSP
  const station = await prisma.station.findUnique({ where: { id: stationId } })
  if (!station || station.dspId !== me.dspId) {
    res.status(403).json({ message: 'Station not found' })
    return
  }

  const source = await prisma.routeCommitment.findMany({
    where: { stationId, weekStart: normFrom },
  })

  // Always delete target week first — copy is a replace, not a merge
  await prisma.routeCommitment.deleteMany({
    where: { stationId, weekStart: normTo },
  })

  if (source.length === 0) {
    res.json({ copied: 0 })
    return
  }

  const inserts = source.map((c) =>
    prisma.routeCommitment.create({
      data: {
        dspId: me.dspId!,
        stationId,
        shiftTypeId: c.shiftTypeId,
        weekStart: normTo,
        sun: c.sun, mon: c.mon, tue: c.tue, wed: c.wed,
        thu: c.thu, fri: c.fri, sat: c.sat,
      },
    })
  )

  await prisma.$transaction(inserts)

  res.json({ copied: source.length })
}
