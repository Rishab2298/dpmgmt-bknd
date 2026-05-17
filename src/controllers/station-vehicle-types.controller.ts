import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function resolveDsp(userId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  return emp?.dspId ?? null
}

async function resolveStation(userId: string, stationId: string) {
  const dspId = await resolveDsp(userId)
  if (!dspId) return null
  const station = await prisma.station.findUnique({ where: { id: stationId } })
  if (!station || station.dspId !== dspId) return null
  return { station, dspId }
}

async function resolveVehicleType(userId: string, stationId: string, typeId: string) {
  const ctx = await resolveStation(userId, stationId)
  if (!ctx) return null
  const vt = await prisma.stationVehicleType.findUnique({ where: { id: typeId } })
  if (!vt || vt.stationId !== stationId) return null
  return { vt, ...ctx }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const nameSchema = z.object({ name: z.string().min(1, 'Name is required').max(100) })

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listStationVehicleTypes(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const stationId = req.params.id as string
  const ctx = await resolveStation(userId!, stationId)
  if (!ctx) { res.status(404).json({ message: 'Station not found' }); return }

  const types = await prisma.stationVehicleType.findMany({
    where: { stationId },
    orderBy: { name: 'asc' },
  })
  res.json(types)
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createStationVehicleType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const stationId = req.params.id as string
  const ctx = await resolveStation(userId!, stationId)
  if (!ctx) { res.status(404).json({ message: 'Station not found' }); return }

  const parsed = nameSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const existing = await prisma.stationVehicleType.findUnique({
    where: { stationId_name: { stationId, name: parsed.data.name } },
  })
  if (existing) { res.status(409).json({ message: 'A vehicle type with this name already exists' }); return }

  const vt = await prisma.stationVehicleType.create({
    data: { stationId, name: parsed.data.name },
  })
  res.status(201).json(vt)
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateStationVehicleType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const stationId = req.params.id as string
  const typeId = req.params.typeId as string
  const ctx = await resolveVehicleType(userId!, stationId, typeId)
  if (!ctx) { res.status(404).json({ message: 'Vehicle type not found' }); return }

  const parsed = nameSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  if (parsed.data.name !== ctx.vt.name) {
    const conflict = await prisma.stationVehicleType.findUnique({
      where: { stationId_name: { stationId, name: parsed.data.name } },
    })
    if (conflict) { res.status(409).json({ message: 'A vehicle type with this name already exists' }); return }
  }

  const updated = await prisma.stationVehicleType.update({
    where: { id: typeId },
    data: { name: parsed.data.name },
  })
  res.json(updated)
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteStationVehicleType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const stationId = req.params.id as string
  const typeId = req.params.typeId as string
  const ctx = await resolveVehicleType(userId!, stationId, typeId)
  if (!ctx) { res.status(404).json({ message: 'Vehicle type not found' }); return }

  await prisma.stationVehicleType.delete({ where: { id: typeId } })
  res.status(204).send()
}
