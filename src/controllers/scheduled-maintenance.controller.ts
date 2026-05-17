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

async function resolveOwnership(userId: string, id: string) {
  const dspId = await resolveDsp(userId)
  if (!dspId) return null
  const record = await prisma.scheduledMaintenance.findUnique({ where: { id } })
  if (!record || record.dspId !== dspId) return null
  return { record, dspId }
}

// ─── Include ──────────────────────────────────────────────────────────────────

const INCLUDE = {
  vehicle: { select: { id: true, vehicleId: true, make: true, model: true, year: true } },
}

// ─── Zod ──────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  vehicleId:   z.string().min(1, 'Vehicle is required'),
  title:       z.string().min(1, 'Title is required'),
  scheduledAt: z.string().min(1, 'Scheduled date is required'),
  description: z.string().optional().nullable(),
  isCompleted: z.boolean().optional(),
  completedAt: z.string().optional().nullable(),
})

const updateSchema = createSchema.partial().omit({ vehicleId: true })

function toDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listScheduled(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const { vehicleId, completed } = req.query as Record<string, string>

  const where: Record<string, unknown> = { dspId }
  if (vehicleId) where.vehicleId = vehicleId
  if (completed === 'true') where.isCompleted = true
  else if (completed === 'false' || !completed) where.isCompleted = false

  const records = await prisma.scheduledMaintenance.findMany({
    where, include: INCLUDE,
    orderBy: { scheduledAt: 'asc' },
  })
  res.json(records)
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createScheduled(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  const vehicle = await prisma.vehicle.findFirst({ where: { id: data.vehicleId, dspId } })
  if (!vehicle) { res.status(400).json({ message: 'Vehicle not found in this DSP' }); return }

  const scheduledAt = toDate(data.scheduledAt)
  if (!scheduledAt) { res.status(400).json({ message: 'Invalid scheduled date' }); return }

  const record = await prisma.scheduledMaintenance.create({
    data: {
      dspId,
      vehicleId: data.vehicleId,
      title: data.title,
      description: data.description ?? null,
      scheduledAt,
      isCompleted: data.isCompleted ?? false,
      completedAt: toDate(data.completedAt),
    },
    include: INCLUDE,
  })
  res.status(201).json(record)
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateScheduled(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Record not found' }); return }

  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const data = parsed.data

  const updateData: Record<string, unknown> = {}
  if ('title' in data) updateData.title = data.title
  if ('description' in data) updateData.description = data.description ?? null
  if ('scheduledAt' in data) updateData.scheduledAt = toDate(data.scheduledAt)
  if ('isCompleted' in data) {
    updateData.isCompleted = data.isCompleted
    if (data.isCompleted && !result.record.completedAt) updateData.completedAt = new Date()
    if (!data.isCompleted) updateData.completedAt = null
  }
  if ('completedAt' in data) updateData.completedAt = toDate(data.completedAt)

  const record = await prisma.scheduledMaintenance.update({
    where: { id },
    data: updateData,
    include: INCLUDE,
  })
  res.json(record)
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteScheduled(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveOwnership(userId!, id)
  if (!result) { res.status(404).json({ message: 'Record not found' }); return }
  await prisma.scheduledMaintenance.delete({ where: { id } })
  res.status(204).send()
}
