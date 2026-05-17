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

async function resolveChecklist(userId: string, id: string) {
  const dspId = await resolveDsp(userId)
  if (!dspId) return null
  const checklist = await prisma.maintenanceChecklist.findUnique({ where: { id } })
  if (!checklist || checklist.dspId !== dspId) return null
  return { checklist, dspId }
}

async function resolveItem(userId: string, itemId: string) {
  const dspId = await resolveDsp(userId)
  if (!dspId) return null
  const item = await prisma.maintenanceChecklistItem.findUnique({
    where: { id: itemId },
    include: { checklist: true },
  })
  if (!item || item.checklist.dspId !== dspId) return null
  return { item, dspId }
}

// ─── Include ──────────────────────────────────────────────────────────────────

const CHECKLIST_INCLUDE = {
  vehicle: { select: { id: true, vehicleId: true, make: true, model: true } },
  items: { orderBy: { sortOrder: 'asc' as const } },
}

// ─── List checklists ──────────────────────────────────────────────────────────

export async function listChecklists(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const { vehicleId } = req.query as Record<string, string>
  const where: Record<string, unknown> = { dspId }
  if (vehicleId) where.vehicleId = vehicleId

  const checklists = await prisma.maintenanceChecklist.findMany({
    where, include: CHECKLIST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  })
  res.json(checklists)
}

// ─── Create checklist ─────────────────────────────────────────────────────────

const createChecklistSchema = z.object({
  vehicleId: z.string().min(1, 'Vehicle is required'),
  title:     z.string().min(1, 'Title is required'),
})

export async function createChecklist(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ message: 'DSP not found' }); return }

  const parsed = createChecklistSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }
  const { vehicleId, title } = parsed.data

  const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, dspId } })
  if (!vehicle) { res.status(400).json({ message: 'Vehicle not found in this DSP' }); return }

  const checklist = await prisma.maintenanceChecklist.create({
    data: { dspId, vehicleId, title },
    include: CHECKLIST_INCLUDE,
  })
  res.status(201).json(checklist)
}

// ─── Update checklist (rename) ────────────────────────────────────────────────

export async function updateChecklist(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveChecklist(userId!, id)
  if (!result) { res.status(404).json({ message: 'Checklist not found' }); return }

  const parsed = z.object({ title: z.string().min(1) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: 'Title is required' }); return }

  const checklist = await prisma.maintenanceChecklist.update({
    where: { id },
    data: { title: parsed.data.title },
    include: CHECKLIST_INCLUDE,
  })
  res.json(checklist)
}

// ─── Delete checklist ─────────────────────────────────────────────────────────

export async function deleteChecklist(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveChecklist(userId!, id)
  if (!result) { res.status(404).json({ message: 'Checklist not found' }); return }
  await prisma.maintenanceChecklist.delete({ where: { id } })
  res.status(204).send()
}

// ─── Add item ─────────────────────────────────────────────────────────────────

export async function addChecklistItem(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const result = await resolveChecklist(userId!, id)
  if (!result) { res.status(404).json({ message: 'Checklist not found' }); return }

  const parsed = z.object({ label: z.string().min(1, 'Label is required') }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const maxOrder = await prisma.maintenanceChecklistItem.aggregate({
    where: { checklistId: id },
    _max: { sortOrder: true },
  })
  const sortOrder = ((maxOrder._max?.sortOrder) ?? -1) + 1

  const item = await prisma.maintenanceChecklistItem.create({
    data: { checklistId: id, label: parsed.data.label, sortOrder },
  })
  res.status(201).json(item)
}

// ─── Toggle item ──────────────────────────────────────────────────────────────

export async function toggleChecklistItem(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const itemId = req.params.itemId as string
  const result = await resolveItem(userId!, itemId)
  if (!result) { res.status(404).json({ message: 'Item not found' }); return }

  const item = await prisma.maintenanceChecklistItem.update({
    where: { id: itemId },
    data: { isChecked: !result.item.isChecked },
  })
  res.json(item)
}

// ─── Delete item ──────────────────────────────────────────────────────────────

export async function deleteChecklistItem(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const itemId = req.params.itemId as string
  const result = await resolveItem(userId!, itemId)
  if (!result) { res.status(404).json({ message: 'Item not found' }); return }
  await prisma.maintenanceChecklistItem.delete({ where: { id: itemId } })
  res.status(204).send()
}
