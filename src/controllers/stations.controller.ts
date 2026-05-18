import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'

// POST /api/dsp/stations
const createStationSchema = z.object({
  code:      z.string().min(1, 'Station code is required').max(20).transform((v) => v.trim().toUpperCase()),
  name:      z.string().max(100).optional(),
  timezone:  z.string().optional(),
  currency:  z.string().optional(),
  isPrimary: z.boolean().optional(),
})

export async function createStation(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const parsed = createStationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0].message })
    return
  }

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: { dspId: true },
  })
  if (!employee?.dspId) {
    res.status(404).json({ error: 'No DSP found for this user' })
    return
  }

  const { code, name, timezone, currency, isPrimary } = parsed.data

  const existing = await prisma.station.findUnique({
    where: { dspId_code: { dspId: employee.dspId, code } },
  })
  if (existing) {
    res.status(409).json({ message: `A station with code "${code}" already exists` })
    return
  }

  const station = await prisma.station.create({
    data: {
      dspId:     employee.dspId,
      code,
      name:      name ?? null,
      timezone:  timezone ?? 'America/New_York',
      currency:  currency ?? 'USD',
      isPrimary: isPrimary ?? false,
    },
    select: { id: true, code: true, name: true, isPrimary: true, address: true },
  })

  res.status(201).json(station)
}

// Helper: resolve caller's dspId and verify they own the station
async function resolveOwnership(userId: string, stationId: string) {
  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  if (!employee?.dspId) return null

  const station = await prisma.station.findUnique({
    where: { id: stationId },
  })
  if (!station || station.dspId !== employee.dspId) return null

  return station
}

// GET /api/stations/:id
export async function getStation(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const station = await resolveOwnership(userId!, id)
  if (!station) {
    res.status(404).json({ error: 'Station not found' })
    return
  }

  res.json(station)
}

const updateStationSchema = z.object({
  name:                        z.string().nullable().optional(),
  timezone:                    z.string().optional(),
  currency:                    z.string().optional(),
  isPrimary:                   z.boolean().optional(),
  enrollInDailySummaryReport:  z.boolean().optional(),
  geofenceEnabled:             z.boolean().optional(),
  geofenceRadius:              z.number().positive().nullable().optional(),
  parkingLotGeofenceEnabled:   z.boolean().optional(),
  parkingLotGeofenceRadius:    z.number().positive().nullable().optional(),
  address:                     z.string().nullable().optional(),
  latitude:                    z.number().nullable().optional(),
  longitude:                   z.number().nullable().optional(),
  parkingLotAddress:           z.string().nullable().optional(),
  parkingLotLat:               z.number().nullable().optional(),
  parkingLotLng:               z.number().nullable().optional(),
  safetyRemindersHtml:         z.string().nullable().optional(),
})

// PATCH /api/stations/:id
export async function updateStation(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const parsed = updateStationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0].message })
    return
  }

  const existing = await resolveOwnership(userId!, id)
  if (!existing) {
    res.status(404).json({ error: 'Station not found' })
    return
  }

  const station = await prisma.station.update({
    where: { id },
    data: parsed.data,
  })

  res.json(station)
}
