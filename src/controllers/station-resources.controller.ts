import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { Prisma, RateCriteria, InvoiceCategory } from '@prisma/client'
import { prisma } from '../lib/prisma'

// ─── Ownership helper ──────────────────────────────────────────────────────────

async function resolveOwnership(userId: string, stationId: string) {
  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  if (!employee?.dspId) return null

  const station = await prisma.station.findUnique({ where: { id: stationId } })
  if (!station || station.dspId !== employee.dspId) return null

  return station
}

// ─── DSP-level Qualifications ─────────────────────────────────────────────────

async function resolveDsp(userId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { dspId: true },
  })
  return emp?.dspId ?? null
}

export async function listDspQualifications(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ error: 'No DSP found for this user' }); return }

  const qualifications = await prisma.qualification.findMany({
    where: { dspId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json(qualifications)
}

const dspQualificationSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100).transform((v) => v.trim()),
})

export async function createDspQualification(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ error: 'No DSP found for this user' }); return }

  const parsed = dspQualificationSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const existing = await prisma.qualification.findUnique({
    where: { dspId_name: { dspId, name: parsed.data.name } },
  })
  if (existing) { res.status(409).json({ message: 'A qualification with this name already exists' }); return }

  const qual = await prisma.qualification.create({
    data: { dspId, name: parsed.data.name },
    select: { id: true, name: true },
  })
  res.status(201).json(qual)
}

export async function updateDspQualification(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const qualId = req.params.qualId as string

  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ error: 'No DSP found for this user' }); return }

  const parsed = dspQualificationSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const qual = await prisma.qualification.findUnique({ where: { id: qualId } })
  if (!qual || qual.dspId !== dspId) { res.status(404).json({ error: 'Qualification not found' }); return }

  if (parsed.data.name !== qual.name) {
    const conflict = await prisma.qualification.findUnique({
      where: { dspId_name: { dspId, name: parsed.data.name } },
    })
    if (conflict) { res.status(409).json({ message: 'A qualification with this name already exists' }); return }
  }

  const updated = await prisma.qualification.update({
    where: { id: qualId },
    data: { name: parsed.data.name },
    select: { id: true, name: true },
  })
  res.json(updated)
}

export async function deleteDspQualification(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const qualId = req.params.qualId as string

  const dspId = await resolveDsp(userId!)
  if (!dspId) { res.status(404).json({ error: 'No DSP found for this user' }); return }

  const qual = await prisma.qualification.findUnique({ where: { id: qualId } })
  if (!qual || qual.dspId !== dspId) { res.status(404).json({ error: 'Qualification not found' }); return }

  const inUse = await prisma.shiftType.count({ where: { qualificationId: qualId } })
  if (inUse > 0) {
    res.status(409).json({ message: 'This qualification is used by one or more shift types and cannot be deleted.' })
    return
  }

  await prisma.qualification.delete({ where: { id: qualId } })
  res.status(204).send()
}

// ─── Station qualification rates ──────────────────────────────────────────────

export async function listStationQualifications(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const [quals, rates] = await Promise.all([
    prisma.qualification.findMany({
      where: { dspId: station.dspId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.stationQualification.findMany({ where: { stationId: id } }),
  ])

  const rateMap = Object.fromEntries(rates.map((r) => [r.qualificationId, r.rate]))
  res.json(quals.map((q) => ({ qualificationId: q.id, name: q.name, rate: rateMap[q.id] ?? null })))
}

const setRateSchema = z.object({
  rate: z.number().nonnegative('Rate must be 0 or greater').nullable().optional(),
})

export async function setStationQualificationRate(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const qualId = req.params.qualId as string

  const parsed = setRateSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const qual = await prisma.qualification.findUnique({ where: { id: qualId } })
  if (!qual || qual.dspId !== station.dspId) { res.status(404).json({ error: 'Qualification not found' }); return }

  const rate = parsed.data.rate ?? null
  await prisma.stationQualification.upsert({
    where: { stationId_qualificationId: { stationId: id, qualificationId: qualId } },
    create: { stationId: id, qualificationId: qualId, rate },
    update: { rate },
  })

  res.json({ qualificationId: qualId, name: qual.name, rate })
}

// ─── Vehicle Groups ───────────────────────────────────────────────────────────

export async function listVehicleGroups(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const groups = await prisma.vehicleGroup.findMany({
    where: { stationId: id },
    include: { vehicleTypes: { include: { stationVehicleType: true } } },
    orderBy: { createdAt: 'asc' },
  })
  res.json(groups)
}

const vehicleGroupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  vehicleTypeIds: z.array(z.string().min(1)).min(1, 'Select at least one vehicle type'),
})

export async function createVehicleGroup(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const parsed = vehicleGroupSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  // Validate all vehicleTypeIds belong to this station
  const vtCount = await prisma.stationVehicleType.count({
    where: { id: { in: parsed.data.vehicleTypeIds }, stationId: id },
  })
  if (vtCount !== parsed.data.vehicleTypeIds.length) {
    res.status(400).json({ message: 'One or more vehicle types not found for this station' }); return
  }

  const existing = await prisma.vehicleGroup.findUnique({
    where: { stationId_name: { stationId: id, name: parsed.data.name } },
  })
  if (existing) { res.status(409).json({ message: 'A vehicle group with this name already exists' }); return }

  const group = await prisma.vehicleGroup.create({
    data: {
      stationId: id,
      name: parsed.data.name,
      vehicleTypes: {
        createMany: {
          data: parsed.data.vehicleTypeIds.map((vtId) => ({ stationVehicleTypeId: vtId })),
        },
      },
    },
    include: { vehicleTypes: { include: { stationVehicleType: true } } },
  })
  res.status(201).json(group)
}

const updateVehicleGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  vehicleTypeIds: z.array(z.string().min(1)).min(1).optional(),
})

export async function updateVehicleGroup(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const groupId = req.params.groupId as string

  const parsed = updateVehicleGroupSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const group = await prisma.vehicleGroup.findUnique({ where: { id: groupId } })
  if (!group || group.stationId !== id) { res.status(404).json({ error: 'Vehicle group not found' }); return }

  if (parsed.data.vehicleTypeIds) {
    const vtCount = await prisma.stationVehicleType.count({
      where: { id: { in: parsed.data.vehicleTypeIds }, stationId: id },
    })
    if (vtCount !== parsed.data.vehicleTypeIds.length) {
      res.status(400).json({ message: 'One or more vehicle types not found for this station' }); return
    }
  }

  if (parsed.data.name && parsed.data.name !== group.name) {
    const conflict = await prisma.vehicleGroup.findUnique({
      where: { stationId_name: { stationId: id, name: parsed.data.name } },
    })
    if (conflict) { res.status(409).json({ message: 'A vehicle group with this name already exists' }); return }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (parsed.data.vehicleTypeIds) {
      await tx.vehicleGroupType.deleteMany({ where: { vehicleGroupId: groupId } })
      await tx.vehicleGroupType.createMany({
        data: parsed.data.vehicleTypeIds.map((vtId) => ({ vehicleGroupId: groupId, stationVehicleTypeId: vtId })),
      })
    }
    return tx.vehicleGroup.update({
      where: { id: groupId },
      data: { ...(parsed.data.name ? { name: parsed.data.name } : {}) },
      include: { vehicleTypes: { include: { stationVehicleType: true } } },
    })
  })

  res.json(updated)
}

export async function deleteVehicleGroup(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const groupId = req.params.groupId as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const group = await prisma.vehicleGroup.findUnique({ where: { id: groupId } })
  if (!group || group.stationId !== id) { res.status(404).json({ error: 'Vehicle group not found' }); return }

  await prisma.$transaction([
    prisma.vehicleGroupType.deleteMany({ where: { vehicleGroupId: groupId } }),
    prisma.vehicleGroup.delete({ where: { id: groupId } }),
  ])
  res.status(204).send()
}

// ─── Rate Cards ───────────────────────────────────────────────────────────────

export async function listRateCards(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const cards = await prisma.rateCard.findMany({
    where: { stationId: id },
    orderBy: { createdAt: 'asc' },
  })
  res.json(cards)
}

const rateCardSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  criteria: z.nativeEnum(RateCriteria),
  effectiveRate: z.number().nonnegative('Rate must be 0 or greater'),
  cumulativeRate: z.number().nonnegative().nullable().optional(),
})

export async function createRateCard(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const parsed = rateCardSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const existing = await prisma.rateCard.findUnique({
    where: { stationId_name: { stationId: id, name: parsed.data.name } },
  })
  if (existing) { res.status(409).json({ message: 'A rate card with this name already exists' }); return }

  const card = await prisma.rateCard.create({
    data: {
      stationId: id,
      name: parsed.data.name,
      criteria: parsed.data.criteria,
      effectiveRate: parsed.data.effectiveRate,
      cumulativeRate: parsed.data.cumulativeRate ?? null,
    },
  })
  res.status(201).json(card)
}

export async function updateRateCard(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const cardId = req.params.cardId as string

  const parsed = rateCardSchema.partial().safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const card = await prisma.rateCard.findUnique({ where: { id: cardId } })
  if (!card || card.stationId !== id) { res.status(404).json({ error: 'Rate card not found' }); return }

  if (parsed.data.name && parsed.data.name !== card.name) {
    const conflict = await prisma.rateCard.findUnique({
      where: { stationId_name: { stationId: id, name: parsed.data.name } },
    })
    if (conflict) { res.status(409).json({ message: 'A rate card with this name already exists' }); return }
  }

  const updated = await prisma.rateCard.update({
    where: { id: cardId },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.criteria !== undefined ? { criteria: parsed.data.criteria } : {}),
      ...(parsed.data.effectiveRate !== undefined ? { effectiveRate: parsed.data.effectiveRate } : {}),
      ...(parsed.data.cumulativeRate !== undefined ? { cumulativeRate: parsed.data.cumulativeRate } : {}),
    },
  })
  res.json(updated)
}

export async function deleteRateCard(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const cardId = req.params.cardId as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const card = await prisma.rateCard.findUnique({ where: { id: cardId } })
  if (!card || card.stationId !== id) { res.status(404).json({ error: 'Rate card not found' }); return }

  await prisma.rateCard.delete({ where: { id: cardId } })
  res.status(204).send()
}

// ─── Invoice Types ────────────────────────────────────────────────────────────

export async function listInvoiceTypes(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const types = await prisma.invoiceType.findMany({
    where: { stationId: id },
    include: { rateCard: true },
    orderBy: { createdAt: 'asc' },
  })
  res.json(types)
}

const VALID_BILLABLE_HOURS = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5,
  6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12,
] as const

const invoiceTypeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  category: z.nativeEnum(InvoiceCategory),
  billableHours: z.number().refine(
    (v) => (VALID_BILLABLE_HOURS as readonly number[]).includes(v),
    { message: 'billableHours must be 0 (flat fee) or 0.5–12 in 0.5-step increments' },
  ),
  rateCardId: z.string().nullable().optional(),
})

async function buildRateSnapshot(rateCardId: string | null | undefined, stationId: string) {
  if (!rateCardId) return Prisma.JsonNull
  const rc = await prisma.rateCard.findUnique({ where: { id: rateCardId } })
  if (!rc || rc.stationId !== stationId) return null // caller should check
  return { name: rc.name, criteria: rc.criteria, effectiveRate: rc.effectiveRate, cumulativeRate: rc.cumulativeRate }
}

export async function createInvoiceType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const parsed = invoiceTypeSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const existing = await prisma.invoiceType.findUnique({
    where: { stationId_name: { stationId: id, name: parsed.data.name } },
  })
  if (existing) { res.status(409).json({ message: 'An invoice type with this name already exists' }); return }

  let rateSnapshot: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull
  if (parsed.data.rateCardId) {
    const snapshot = await buildRateSnapshot(parsed.data.rateCardId, id)
    if (snapshot === null) { res.status(400).json({ message: 'Rate card not found' }); return }
    rateSnapshot = snapshot as Prisma.InputJsonValue
  }

  const type = await prisma.invoiceType.create({
    data: {
      stationId: id,
      name: parsed.data.name,
      category: parsed.data.category,
      billableHours: parsed.data.billableHours,
      rateCardId: parsed.data.rateCardId ?? null,
      rateSnapshot,
    },
    include: { rateCard: true },
  })
  res.status(201).json(type)
}

export async function updateInvoiceType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const typeId = req.params.typeId as string

  const parsed = invoiceTypeSchema.partial().safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const type = await prisma.invoiceType.findUnique({ where: { id: typeId } })
  if (!type || type.stationId !== id) { res.status(404).json({ error: 'Invoice type not found' }); return }

  if (parsed.data.name && parsed.data.name !== type.name) {
    const conflict = await prisma.invoiceType.findUnique({
      where: { stationId_name: { stationId: id, name: parsed.data.name } },
    })
    if (conflict) { res.status(409).json({ message: 'An invoice type with this name already exists' }); return }
  }

  // Re-snapshot rate card if rateCardId is changing
  let rateSnapshot: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined = undefined
  if (parsed.data.rateCardId !== undefined) {
    if (parsed.data.rateCardId) {
      const snapshot = await buildRateSnapshot(parsed.data.rateCardId, id)
      if (snapshot === null) { res.status(400).json({ message: 'Rate card not found' }); return }
      rateSnapshot = snapshot as Prisma.InputJsonValue
    } else {
      rateSnapshot = Prisma.JsonNull
    }
  }

  const updateData: Prisma.InvoiceTypeUpdateInput = {}
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name
  if (parsed.data.category !== undefined) updateData.category = parsed.data.category
  if (parsed.data.billableHours !== undefined) updateData.billableHours = parsed.data.billableHours
  if (parsed.data.rateCardId !== undefined) updateData.rateCard = parsed.data.rateCardId
    ? { connect: { id: parsed.data.rateCardId } }
    : { disconnect: true }
  if (rateSnapshot !== undefined) updateData.rateSnapshot = rateSnapshot

  const updated = await prisma.invoiceType.update({
    where: { id: typeId },
    data: updateData,
    include: { rateCard: true },
  })
  res.json(updated)
}

export async function deleteInvoiceType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const typeId = req.params.typeId as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const type = await prisma.invoiceType.findUnique({ where: { id: typeId } })
  if (!type || type.stationId !== id) { res.status(404).json({ error: 'Invoice type not found' }); return }

  await prisma.invoiceType.delete({ where: { id: typeId } })
  res.status(204).send()
}

// ─── Shift Types ──────────────────────────────────────────────────────────────

const shiftTypeInclude = {
  vehicleGroup:  { select: { id: true, name: true } },
  qualification: { select: { id: true, name: true } },
  invoiceType:   { select: { id: true, name: true } },
} as const

export async function listShiftTypes(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const shiftTypes = await prisma.shiftType.findMany({
    where: { stationId: id },
    include: shiftTypeInclude,
    orderBy: { createdAt: 'asc' },
  })
  res.json(shiftTypes)
}

const createShiftTypeSchema = z.object({
  name:            z.string().min(1, 'Name is required').max(100),
  vehicleGroupId:  z.string().min(1, 'Vehicle group is required'),
  qualificationId: z.string().min(1, 'Qualification is required'),
  invoiceTypeId:   z.string().min(1, 'Invoice type is required'),
  color:           z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color'),
  durationMinutes: z.number().int().min(30, 'Duration must be at least 0.5 hr').max(780, 'Duration cannot exceed 13 hrs'),
  breakMinutes:    z.number().int().min(0, 'Break must be 0 or more'),
  notes:           z.string().max(500).optional(),
})

const updateShiftTypeSchema = createShiftTypeSchema.partial()

export async function createShiftType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const parsed = createShiftTypeSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const qual = await prisma.qualification.findUnique({ where: { id: parsed.data.qualificationId } })
  if (!qual || qual.dspId !== station.dspId) { res.status(400).json({ message: 'Invalid qualification' }); return }

  const existing = await prisma.shiftType.findUnique({
    where: { stationId_name: { stationId: id, name: parsed.data.name } },
  })
  if (existing) { res.status(409).json({ message: 'A shift type with this name already exists' }); return }

  const shiftType = await prisma.shiftType.create({
    data: {
      stationId:       id,
      name:            parsed.data.name,
      vehicleGroupId:  parsed.data.vehicleGroupId,
      qualificationId: parsed.data.qualificationId,
      invoiceTypeId:   parsed.data.invoiceTypeId,
      color:           parsed.data.color,
      durationMinutes: parsed.data.durationMinutes,
      breakMinutes:    parsed.data.breakMinutes,
      notes:           parsed.data.notes ?? null,
    },
    include: shiftTypeInclude,
  })
  res.status(201).json(shiftType)
}

export async function updateShiftType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const shiftTypeId = req.params.shiftTypeId as string

  const parsed = updateShiftTypeSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.issues[0].message }); return }

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  if (parsed.data.qualificationId) {
    const qual = await prisma.qualification.findUnique({ where: { id: parsed.data.qualificationId } })
    if (!qual || qual.dspId !== station.dspId) { res.status(400).json({ message: 'Invalid qualification' }); return }
  }

  const st = await prisma.shiftType.findUnique({ where: { id: shiftTypeId } })
  if (!st || st.stationId !== id) { res.status(404).json({ error: 'Shift type not found' }); return }

  if (parsed.data.name && parsed.data.name !== st.name) {
    const conflict = await prisma.shiftType.findUnique({
      where: { stationId_name: { stationId: id, name: parsed.data.name } },
    })
    if (conflict) { res.status(409).json({ message: 'A shift type with this name already exists' }); return }
  }

  const updated = await prisma.shiftType.update({
    where: { id: shiftTypeId },
    data: {
      ...(parsed.data.name            !== undefined ? { name:            parsed.data.name            } : {}),
      ...(parsed.data.vehicleGroupId  !== undefined ? { vehicleGroupId:  parsed.data.vehicleGroupId  } : {}),
      ...(parsed.data.qualificationId !== undefined ? { qualificationId: parsed.data.qualificationId } : {}),
      ...(parsed.data.invoiceTypeId   !== undefined ? { invoiceTypeId:   parsed.data.invoiceTypeId   } : {}),
      ...(parsed.data.color           !== undefined ? { color:           parsed.data.color           } : {}),
      ...(parsed.data.durationMinutes !== undefined ? { durationMinutes: parsed.data.durationMinutes } : {}),
      ...(parsed.data.breakMinutes    !== undefined ? { breakMinutes:    parsed.data.breakMinutes    } : {}),
      ...(parsed.data.notes           !== undefined ? { notes:           parsed.data.notes           } : {}),
    },
    include: shiftTypeInclude,
  })
  res.json(updated)
}

export async function deleteShiftType(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string
  const shiftTypeId = req.params.shiftTypeId as string

  const station = await resolveOwnership(userId!, id)
  if (!station) { res.status(404).json({ error: 'Station not found' }); return }

  const st = await prisma.shiftType.findUnique({ where: { id: shiftTypeId } })
  if (!st || st.stationId !== id) { res.status(404).json({ error: 'Shift type not found' }); return }

  if (st.isSystemType) { res.status(403).json({ error: 'System shift types cannot be deleted' }); return }

  await prisma.shiftType.delete({ where: { id: shiftTypeId } })
  res.status(204).send()
}
