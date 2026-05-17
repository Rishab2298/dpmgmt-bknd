import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { LoadOutTaskType, ActivityEntityType, VehicleImageCategory, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import multer from 'multer'
import path from 'path'
import fs from 'fs'

// ─── Upload directory ─────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'loadout')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

export const photoUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  },
}).single('file')

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function resolveEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { id: true, dspId: true, permissionLevel: true, legalFirstName: true, legalLastName: true },
  })
}

async function resolveStationOwnership(userId: string, stationId: string) {
  const emp = await resolveEmployee(userId)
  if (!emp?.dspId) return null
  const station = await prisma.station.findUnique({ where: { id: stationId }, select: { id: true, dspId: true } })
  if (!station || station.dspId !== emp.dspId) return null
  return { emp, dspId: emp.dspId }
}

// ─── Activity log helper ──────────────────────────────────────────────────────

async function writeLog(opts: {
  dspId: string
  entityType: ActivityEntityType
  entityId: string
  action: string
  metadata?: Record<string, unknown>
  performedByClerkId?: string
  performedByName?: string
}) {
  await prisma.activityLog.create({
    data: {
      dspId: opts.dspId,
      entityType: opts.entityType,
      entityId: opts.entityId,
      action: opts.action,
      metadata: opts.metadata as object | undefined,
      performedByClerkId: opts.performedByClerkId,
      performedByName: opts.performedByName,
    },
  })
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const updateIntroSchema = z.object({
  introduction: z.string().max(2000).nullable(),
})

const createSectionSchema = z.object({
  templateId: z.string().min(1),
  title: z.string().min(1).max(100).transform((v) => v.trim()),
})

const updateSectionSchema = z.object({
  title: z.string().min(1).max(100).transform((v) => v.trim()),
})

const reorderSchema = z.array(
  z.object({ id: z.string(), sortOrder: z.number().int() })
)

const createTaskSchema = z.object({
  sectionId: z.string().min(1),
  type: z.nativeEnum(LoadOutTaskType),
  label: z.string().min(1).max(500).transform((v) => v.trim()),
  description: z.string().max(1000).optional().nullable(),
  required: z.boolean().default(true),
  metadata: z.record(z.unknown()).optional().nullable(),
})

const updateTaskSchema = z.object({
  type: z.nativeEnum(LoadOutTaskType).optional(),
  label: z.string().min(1).max(500).transform((v) => v.trim()).optional(),
  description: z.string().max(1000).optional().nullable(),
  required: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
})

const submitLoadOutSchema = z.object({
  answers: z.array(z.object({
    taskId: z.string(),
    boolValue: z.boolean().optional().nullable(),
    textValue: z.string().optional().nullable(),
    numericValue: z.number().optional().nullable(),
    photoUrls: z.array(z.string()).default([]),
    metadata: z.record(z.unknown()).optional().nullable(),
  })),
})

// ─── Full template include ────────────────────────────────────────────────────

const TEMPLATE_INCLUDE = {
  sections: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      tasks: { orderBy: { sortOrder: 'asc' as const } },
    },
  },
}

// ─── Admin: Get or create template for station ────────────────────────────────

export async function getLoadOutTemplate(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const stationId = (req.params.id ?? req.params.stationId) as string

  const ctx = await resolveStationOwnership(userId!, stationId)
  if (!ctx) { res.status(404).json({ message: 'Station not found' }); return }

  // Auto-create empty template if none exists
  let template = await prisma.loadOutTemplate.findUnique({
    where: { stationId },
    include: TEMPLATE_INCLUDE,
  })

  if (!template) {
    template = await prisma.loadOutTemplate.create({
      data: { stationId, dspId: ctx.dspId },
      include: TEMPLATE_INCLUDE,
    })
  }

  res.json(template)
}

// ─── Admin: Update introduction text ─────────────────────────────────────────

export async function updateLoadOutTemplate(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const stationId = (req.params.id ?? req.params.stationId) as string

  const ctx = await resolveStationOwnership(userId!, stationId)
  if (!ctx) { res.status(404).json({ message: 'Station not found' }); return }

  const parsed = updateIntroSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.errors[0].message }); return }

  const template = await prisma.loadOutTemplate.upsert({
    where: { stationId },
    create: { stationId, dspId: ctx.dspId, introduction: parsed.data.introduction },
    update: { introduction: parsed.data.introduction },
    include: TEMPLATE_INCLUDE,
  })

  res.json(template)
}

// ─── Admin: Create section ────────────────────────────────────────────────────

export async function createSection(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const parsed = createSectionSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.errors[0].message }); return }

  // Verify template belongs to caller's DSP
  const template = await prisma.loadOutTemplate.findUnique({
    where: { id: parsed.data.templateId },
    select: { id: true, stationId: true, dspId: true },
  })
  if (!template) { res.status(404).json({ message: 'Template not found' }); return }

  const ctx = await resolveStationOwnership(userId!, template.stationId)
  if (!ctx) { res.status(403).json({ message: 'Forbidden' }); return }

  // Append at end
  const maxOrder = await prisma.loadOutSection.aggregate({
    where: { templateId: parsed.data.templateId },
    _max: { sortOrder: true },
  })
  const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1

  const section = await prisma.loadOutSection.create({
    data: { templateId: parsed.data.templateId, title: parsed.data.title, sortOrder },
    include: { tasks: { orderBy: { sortOrder: 'asc' } } },
  })

  res.status(201).json(section)
}

// ─── Admin: Update section ────────────────────────────────────────────────────

export async function updateSection(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const parsed = updateSectionSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.errors[0].message }); return }

  const section = await prisma.loadOutSection.findUnique({
    where: { id },
    include: { template: { select: { stationId: true } } },
  })
  if (!section) { res.status(404).json({ message: 'Section not found' }); return }

  const ctx = await resolveStationOwnership(userId!, section.template.stationId)
  if (!ctx) { res.status(403).json({ message: 'Forbidden' }); return }

  const updated = await prisma.loadOutSection.update({
    where: { id },
    data: { title: parsed.data.title },
    include: { tasks: { orderBy: { sortOrder: 'asc' } } },
  })

  res.json(updated)
}

// ─── Admin: Delete section (cascades tasks) ───────────────────────────────────

export async function deleteSection(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const section = await prisma.loadOutSection.findUnique({
    where: { id },
    include: { template: { select: { stationId: true } } },
  })
  if (!section) { res.status(404).json({ message: 'Section not found' }); return }

  const ctx = await resolveStationOwnership(userId!, section.template.stationId)
  if (!ctx) { res.status(403).json({ message: 'Forbidden' }); return }

  await prisma.loadOutSection.delete({ where: { id } })
  res.status(204).send()
}

// ─── Admin: Reorder sections ──────────────────────────────────────────────────

export async function reorderSections(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const parsed = reorderSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: 'Invalid reorder payload' }); return }

  // Verify first section's template belongs to caller
  if (parsed.data.length > 0) {
    const first = await prisma.loadOutSection.findUnique({
      where: { id: parsed.data[0].id },
      include: { template: { select: { stationId: true } } },
    })
    if (!first) { res.status(404).json({ message: 'Section not found' }); return }
    const ctx = await resolveStationOwnership(userId!, first.template.stationId)
    if (!ctx) { res.status(403).json({ message: 'Forbidden' }); return }
  }

  await prisma.$transaction(
    parsed.data.map((item) =>
      prisma.loadOutSection.update({ where: { id: item.id }, data: { sortOrder: item.sortOrder } })
    )
  )

  res.json({ ok: true })
}

// ─── Admin: Create task ───────────────────────────────────────────────────────

export async function createTask(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const parsed = createTaskSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.errors[0].message }); return }

  const section = await prisma.loadOutSection.findUnique({
    where: { id: parsed.data.sectionId },
    include: { template: { select: { stationId: true } } },
  })
  if (!section) { res.status(404).json({ message: 'Section not found' }); return }

  const ctx = await resolveStationOwnership(userId!, section.template.stationId)
  if (!ctx) { res.status(403).json({ message: 'Forbidden' }); return }

  const maxOrder = await prisma.loadOutTask.aggregate({
    where: { sectionId: parsed.data.sectionId },
    _max: { sortOrder: true },
  })
  const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1

  const task = await prisma.loadOutTask.create({
    data: {
      sectionId: parsed.data.sectionId,
      type: parsed.data.type,
      label: parsed.data.label,
      description: parsed.data.description ?? null,
      required: parsed.data.required,
      sortOrder,
      metadata: parsed.data.metadata == null ? Prisma.DbNull : parsed.data.metadata as Prisma.InputJsonValue,
    },
  })

  res.status(201).json(task)
}

// ─── Admin: Update task ───────────────────────────────────────────────────────

export async function updateTask(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const parsed = updateTaskSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.errors[0].message }); return }

  const task = await prisma.loadOutTask.findUnique({
    where: { id },
    include: { section: { include: { template: { select: { stationId: true } } } } },
  })
  if (!task) { res.status(404).json({ message: 'Task not found' }); return }

  const ctx = await resolveStationOwnership(userId!, task.section.template.stationId)
  if (!ctx) { res.status(403).json({ message: 'Forbidden' }); return }

  const updated = await prisma.loadOutTask.update({
    where: { id },
    data: {
      ...(parsed.data.type !== undefined && { type: parsed.data.type }),
      ...(parsed.data.label !== undefined && { label: parsed.data.label }),
      ...(parsed.data.description !== undefined && { description: parsed.data.description }),
      ...(parsed.data.required !== undefined && { required: parsed.data.required }),
      ...(parsed.data.metadata !== undefined && {
        metadata: parsed.data.metadata === null ? Prisma.DbNull : parsed.data.metadata as Prisma.InputJsonValue,
      }),
    },
  })

  res.json(updated)
}

// ─── Admin: Delete task ───────────────────────────────────────────────────────

export async function deleteTask(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const id = req.params.id as string

  const task = await prisma.loadOutTask.findUnique({
    where: { id },
    include: { section: { include: { template: { select: { stationId: true } } } } },
  })
  if (!task) { res.status(404).json({ message: 'Task not found' }); return }

  const ctx = await resolveStationOwnership(userId!, task.section.template.stationId)
  if (!ctx) { res.status(403).json({ message: 'Forbidden' }); return }

  await prisma.loadOutTask.delete({ where: { id } })
  res.status(204).send()
}

// ─── Admin: Reorder tasks ─────────────────────────────────────────────────────

export async function reorderTasks(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const parsed = reorderSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: 'Invalid reorder payload' }); return }

  if (parsed.data.length > 0) {
    const first = await prisma.loadOutTask.findUnique({
      where: { id: parsed.data[0].id },
      include: { section: { include: { template: { select: { stationId: true } } } } },
    })
    if (!first) { res.status(404).json({ message: 'Task not found' }); return }
    const ctx = await resolveStationOwnership(userId!, first.section.template.stationId)
    if (!ctx) { res.status(403).json({ message: 'Forbidden' }); return }
  }

  await prisma.$transaction(
    parsed.data.map((item) =>
      prisma.loadOutTask.update({ where: { id: item.id }, data: { sortOrder: item.sortOrder } })
    )
  )

  res.json({ ok: true })
}

// ─── Driver: Get today's loadout ──────────────────────────────────────────────

export async function getDriverLoadOut(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const emp = await resolveEmployee(userId!)
  if (!emp?.dspId) { res.status(403).json({ message: 'No employee record found' }); return }

  // Find today's (or yesterday's) shift — yesterday included as a 1-day timezone buffer
  // so server UTC date never causes a mismatch for DSPs in positive UTC offsets.
  // We prefer today over yesterday via orderBy date DESC.
  const today     = new Date().toLocaleDateString('en-CA') // "YYYY-MM-DD"
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA')
  const shift = await prisma.shift.findFirst({
    where: {
      employeeId: emp.id,
      date: { in: [today, yesterday] },
      status: { in: ['PUBLISHED', 'CONFIRMED'] },
    },
    orderBy: { date: 'desc' }, // prefer today if both exist
    include: {
      vehicle: { select: { id: true, vin: true, licensePlate: true, make: true, model: true, year: true } },
      shiftType: { select: { name: true, startTime: true, endTime: true } },
      loadOutSubmission: { select: { id: true, completedAt: true } },
    },
  })

  if (!shift) {
    res.json({ state: 'NO_SHIFT', shift: null, template: null, submission: null })
    return
  }

  // Time gate — form only available once shift has started
  const effectiveStart = shift.startTime ?? shift.shiftType?.startTime ?? null
  if (effectiveStart) {
    const now = new Date()
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (currentTime < effectiveStart) {
      res.json({ state: 'FUTURE', shift: { startTime: effectiveStart }, template: null, submission: null })
      return
    }
  }

  // If already submitted, return completed state
  if (shift.loadOutSubmission) {
    res.json({ state: 'COMPLETED', shift, template: null, submission: shift.loadOutSubmission })
    return
  }

  // Fetch the station's loadout template
  const template = await prisma.loadOutTemplate.findUnique({
    where: { stationId: shift.stationId },
    include: TEMPLATE_INCLUDE,
  })

  res.json({
    state: 'PENDING',
    shift: {
      id: shift.id,
      date: shift.date,
      startTime: shift.startTime ?? shift.shiftType?.startTime ?? null,
      endTime: shift.endTime ?? shift.shiftType?.endTime ?? null,
      vehicle: shift.vehicle,
      stationId: shift.stationId,
    },
    template,
    submission: null,
  })
}

// ─── Driver: Upload photo ─────────────────────────────────────────────────────

export async function uploadLoadOutPhoto(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const emp = await resolveEmployee(userId!)
  if (!emp) { res.status(403).json({ message: 'No employee record found' }); return }
  if (!req.file) { res.status(400).json({ message: 'No file uploaded' }); return }

  const url = `/uploads/loadout/${req.file.filename}`
  res.status(201).json({ url })
}

// ─── Driver: Submit loadout ───────────────────────────────────────────────────

export async function submitLoadOut(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const emp = await resolveEmployee(userId!)
  if (!emp?.dspId) { res.status(403).json({ message: 'No employee record found' }); return }

  const parsed = submitLoadOutSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: parsed.error.errors[0].message }); return }

  // Find today's active shift
  const today = new Date().toLocaleDateString('en-CA')
  const shift = await prisma.shift.findFirst({
    where: {
      employeeId: emp.id,
      date: today,
      status: { in: ['PUBLISHED', 'CONFIRMED'] },
    },
    include: {
      vehicle: { select: { id: true, vin: true } },
      loadOutSubmission: { select: { id: true } },
    },
  })

  if (!shift) { res.status(400).json({ message: 'No active shift found for today' }); return }
  if (shift.loadOutSubmission) { res.status(409).json({ message: 'Load out already submitted for this shift' }); return }

  // Fetch the template tasks to validate required fields
  const template = await prisma.loadOutTemplate.findUnique({
    where: { stationId: shift.stationId },
    include: {
      sections: {
        include: { tasks: true },
      },
    },
  })

  const allTasks = template?.sections.flatMap((s) => s.tasks) ?? []
  const requiredTaskIds = new Set(allTasks.filter((t) => t.required).map((t) => t.id))
  const answeredTaskIds = new Set(parsed.data.answers.map((a) => a.taskId))

  for (const taskId of requiredTaskIds) {
    if (!answeredTaskIds.has(taskId)) {
      res.status(400).json({ message: 'All required tasks must be answered before submitting' })
      return
    }
  }

  const now = new Date()
  const performerName = `${emp.legalFirstName} ${emp.legalLastName}`

  // Build answers with side-effect metadata
  const enrichedAnswers = parsed.data.answers.map((answer) => {
    const task = allTasks.find((t) => t.id === answer.taskId)
    const meta = (task?.metadata ?? {}) as Record<string, unknown>
    const answerMeta: Record<string, unknown> = { ...(answer.metadata ?? {}) }

    if (task?.type === 'VIN_SCAN' && meta.verifyVin && shift.vehicle) {
      const vinVerified = answer.textValue?.trim().toUpperCase() === shift.vehicle.vin?.trim().toUpperCase()
      answerMeta.vinVerified = vinVerified
      answerMeta.vinMismatch = !vinVerified
      answerMeta.expectedVin = shift.vehicle.vin
    }

    if (task?.type === 'NUMERIC' && meta.updatesFuelPercent) {
      answerMeta.updatedVehicleField = 'currentFuelPercent'
    }
    if (task?.type === 'NUMERIC' && meta.updatesMileage) {
      answerMeta.updatedVehicleField = 'currentMileage'
    }

    return { ...answer, metadata: answerMeta }
  })

  // Create submission + answers in a transaction
  const submission = await prisma.$transaction(async (tx) => {
    const sub = await tx.loadOutSubmission.create({
      data: {
        dspId: emp.dspId!,
        stationId: shift.stationId,
        shiftId: shift.id,
        vehicleId: shift.vehicleId ?? null,
        employeeId: emp.id,
        completedAt: now,
        answers: {
          create: enrichedAnswers.map((a) => ({
            taskId: a.taskId,
            boolValue: a.boolValue ?? null,
            textValue: a.textValue ?? null,
            numericValue: a.numericValue ?? null,
            photoUrls: a.photoUrls,
            metadata: a.metadata as object,
          })),
        },
      },
      include: { answers: true },
    })

    // Write back fuel % and mileage to vehicle
    if (shift.vehicleId) {
      const fuelAnswer = enrichedAnswers.find(
        (a) => (a.metadata as Record<string, unknown>).updatedVehicleField === 'currentFuelPercent'
      )
      const mileageAnswer = enrichedAnswers.find(
        (a) => (a.metadata as Record<string, unknown>).updatedVehicleField === 'currentMileage'
      )

      const vehicleUpdate: Record<string, unknown> = {}
      if (fuelAnswer?.numericValue != null) vehicleUpdate.currentFuelPercent = fuelAnswer.numericValue
      if (mileageAnswer?.numericValue != null) vehicleUpdate.currentMileage = mileageAnswer.numericValue

      if (Object.keys(vehicleUpdate).length > 0) {
        await tx.vehicle.update({ where: { id: shift.vehicleId }, data: vehicleUpdate })
      }
    }

    // Create VehicleImage records for PHOTO answers
    if (shift.vehicleId) {
      const photoAnswers = enrichedAnswers.filter((a) => {
        const task = allTasks.find((t) => t.id === a.taskId)
        return task?.type === 'PHOTO' && a.photoUrls.length > 0
      })

      for (const answer of photoAnswers) {
        for (const url of answer.photoUrls) {
          await tx.vehicleImage.create({
            data: {
              vehicleId: shift.vehicleId,
              dspId: emp.dspId!,
              category: VehicleImageCategory.LOAD_OUT_INSPECTION,
              url,
              uploadedByEmployeeId: emp.id,
              shiftId: shift.id,
              takenAt: now,
            },
          })
        }
      }
    }

    return sub
  })

  // Activity logs on vehicle (outside transaction for non-critical)
  if (shift.vehicleId) {
    const logBase = {
      dspId: emp.dspId!,
      entityType: ActivityEntityType.VEHICLE,
      entityId: shift.vehicleId,
      performedByClerkId: userId!,
      performedByName: performerName,
    }

    await writeLog({ ...logBase, action: `Load out completed by ${performerName}` })

    // Fuel log
    const fuelAnswer = enrichedAnswers.find(
      (a) => (a.metadata as Record<string, unknown>).updatedVehicleField === 'currentFuelPercent'
    )
    if (fuelAnswer?.numericValue != null) {
      await writeLog({ ...logBase, action: `Fuel level recorded: ${fuelAnswer.numericValue}%` })
    }

    // Mileage log
    const mileageAnswer = enrichedAnswers.find(
      (a) => (a.metadata as Record<string, unknown>).updatedVehicleField === 'currentMileage'
    )
    if (mileageAnswer?.numericValue != null) {
      await writeLog({ ...logBase, action: `Mileage recorded: ${mileageAnswer.numericValue.toLocaleString()} mi` })
    }

    // VIN verification log
    const vinAnswer = enrichedAnswers.find((a) => {
      const task = allTasks.find((t) => t.id === a.taskId)
      return task?.type === 'VIN_SCAN'
    })
    if (vinAnswer) {
      const meta = vinAnswer.metadata as Record<string, unknown>
      if (meta.vinMismatch) {
        await writeLog({
          ...logBase,
          action: `VIN mismatch during load out — expected: ${meta.expectedVin}, scanned: ${vinAnswer.textValue}`,
        })
      } else if (meta.vinVerified) {
        await writeLog({ ...logBase, action: `VIN verified during load out: ${vinAnswer.textValue}` })
      }
    }

    // Photo log
    const totalPhotos = enrichedAnswers.reduce((acc, a) => acc + a.photoUrls.length, 0)
    if (totalPhotos > 0) {
      await writeLog({ ...logBase, action: `Load out photos uploaded: ${totalPhotos} photo(s) (LOAD_OUT_INSPECTION)` })
    }
  }

  res.status(201).json({ submissionId: submission.id, completedAt: submission.completedAt })
}
