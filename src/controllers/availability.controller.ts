import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getCallerEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { id: true, dspId: true, primaryStationId: true },
  })
}

// ─── GET /api/availability/me ─────────────────────────────────────────────────
// Returns the driver's own availability for a given week, or null if not submitted.

export async function getMyAvailability(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const { weekStart } = req.query as Record<string, string>

  if (!weekStart) {
    res.status(400).json({ message: 'weekStart is required' })
    return
  }

  const me = await getCallerEmployee(userId!)
  if (!me) { res.status(404).json({ message: 'Employee not found' }); return }

  const record = await prisma.availability.findUnique({
    where: { employeeId_weekStartDate: { employeeId: me.id, weekStartDate: weekStart } },
    select: {
      weekStartDate: true,
      status: true,
      notes: true,
      slots: { select: { date: true, startTime: true, endTime: true } },
    },
  })

  res.json(record ?? null)
}

// ─── PUT /api/availability/me ─────────────────────────────────────────────────
// Driver submits or replaces their availability for a week.

const submitSchema = z.object({
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStartDate must be YYYY-MM-DD'),
  slots: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'startTime must be HH:MM').nullable(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/, 'endTime must be HH:MM').nullable(),
  })).max(7),
})

export async function submitAvailability(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const parsed = submitSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Invalid request' })
    return
  }

  const { weekStartDate, slots } = parsed.data

  const me = await getCallerEmployee(userId!)
  if (!me) { res.status(404).json({ message: 'Employee not found' }); return }
  if (!me.dspId) { res.status(400).json({ message: 'Employee has no DSP' }); return }
  if (!me.primaryStationId) { res.status(400).json({ message: 'Employee has no primary station' }); return }

  // Upsert the Availability record
  const availability = await prisma.availability.upsert({
    where: { employeeId_weekStartDate: { employeeId: me.id, weekStartDate } },
    update: { status: 'SUBMITTED', updatedAt: new Date() },
    create: {
      dspId: me.dspId,
      stationId: me.primaryStationId,
      employeeId: me.id,
      weekStartDate,
      status: 'SUBMITTED',
    },
  })

  // Replace all slots for this availability
  await prisma.availabilitySlot.deleteMany({ where: { availabilityId: availability.id } })

  if (slots.length > 0) {
    await prisma.availabilitySlot.createMany({
      data: slots.map((s) => ({
        availabilityId: availability.id,
        date: s.date,
        startTime: s.startTime ?? null,
        endTime: s.endTime ?? null,
      })),
    })
  }

  const result = await prisma.availability.findUnique({
    where: { id: availability.id },
    select: {
      weekStartDate: true,
      status: true,
      notes: true,
      slots: { select: { date: true, startTime: true, endTime: true } },
    },
  })

  res.json(result)
}

// ─── GET /api/availability ────────────────────────────────────────────────────
// Operator/dispatcher reads all driver availability for a station/week.

export async function getStationAvailability(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const { stationId, weekStart } = req.query as Record<string, string>

  if (!stationId || !weekStart) {
    res.status(400).json({ message: 'stationId and weekStart are required' })
    return
  }

  const me = await getCallerEmployee(userId!)
  if (!me?.dspId) { res.status(404).json({ message: 'No DSP found' }); return }

  const slots = await prisma.availabilitySlot.findMany({
    where: {
      availability: {
        dspId: me.dspId,
        stationId,
        weekStartDate: weekStart,
      },
    },
    select: {
      date: true,
      startTime: true,
      endTime: true,
      availability: { select: { employeeId: true } },
    },
  })

  res.json(
    slots.map((s) => ({
      employeeId: s.availability.employeeId,
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
    }))
  )
}
