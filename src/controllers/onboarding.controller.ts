import { Request, Response } from 'express'
import { getAuth, clerkClient } from '@clerk/express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'

// GET /api/onboarding/me
export async function getMe(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: {
      id: true,
      // Name
      legalFirstName: true,
      legalMiddleName: true,
      legalLastName: true,
      nickname: true,
      // Employment
      title: true,
      positions: true,
      status: true,
      permissionLevel: true,
      employeeCode: true,
      hireDate: true,
      // Contact
      workEmail: true,
      workMobile: true,
      workPhone: true,
      personalMobile: true,
      personalEmail: true,
      // IDs
      dspId: true,
      primaryStationId: true,
      // Relations
      primaryStation: { select: { id: true, code: true, name: true } },
      supervisor: { select: { id: true, legalFirstName: true, legalLastName: true, nickname: true } },
      emergencyContacts: { orderBy: { sortOrder: 'asc' as const } },
      employeeQualifications: {
        include: { qualification: { select: { id: true, name: true } } },
      },
    },
  })

  if (!employee) {
    res.status(404).json({ error: 'Employee not found' })
    return
  }

  res.json(employee)
}

const personalSchema = z.object({
  legalFirstName: z.string().min(1),
  legalLastName: z.string().min(1),
  personalMobile: z.string().min(7),
})

// PATCH /api/onboarding/personal
export async function updatePersonal(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const parsed = personalSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0].message })
    return
  }
  const body = parsed.data

  // Upsert: create the row if the webhook missed it (e.g. first run before tunnel was up)
  const clerkUser = await clerkClient.users.getUser(userId!)
  const primaryEmail = clerkUser.emailAddresses.find(
    (e) => e.id === clerkUser.primaryEmailAddressId
  )?.emailAddress

  const employee = await prisma.employee.upsert({
    where: { clerkUserId: userId! },
    create: {
      clerkUserId: userId!,
      legalFirstName: body.legalFirstName,
      legalLastName: body.legalLastName,
      personalMobile: body.personalMobile,
      workEmail: primaryEmail,
      status: 'ONBOARDING',
      permissionLevel: 'DELIVERY_ASSOCIATE',
    },
    update: {
      legalFirstName: body.legalFirstName,
      legalLastName: body.legalLastName,
      personalMobile: body.personalMobile,
    },
    select: { id: true, legalFirstName: true, legalLastName: true, personalMobile: true },
  })

  res.json(employee)
}

const completeSchema = z.object({
  dspName: z.string().min(1),
  amazonDspCode: z.string().min(1),
  stationCode: z.string().min(1),
  referralSource: z.enum(['GOOGLE', 'REFERRAL', 'AMAZON_NETWORK', 'SOCIAL_MEDIA', 'OTHER']),
  referralId: z.string().optional(),
  acceptedPolicies: z.literal(true),
})

// POST /api/onboarding/complete
export async function completeOnboarding(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const parsed = completeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0].message })
    return
  }
  const body = parsed.data

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
  })

  if (!employee) {
    res.status(404).json({ error: 'Employee not found' })
    return
  }

  if (employee.dspId) {
    res.status(409).json({ error: 'Onboarding already completed' })
    return
  }

  // Recovery: if a DSP with this amazonDspId already exists (e.g. from a partially
  // completed prior attempt), find it and just link the employee rather than trying
  // to create a duplicate. This prevents a unique-constraint crash on retry.
  const existingDsp = await prisma.dsp.findUnique({
    where: { amazonDspId: body.amazonDspCode },
    include: { stations: { where: { isPrimary: true }, take: 1 } },
  })

  let result: { dsp: { id: string; name: string }; station: { id: string; code: string }; employee: typeof employee }

  if (existingDsp) {
    // DSP already created — just wire up the employee
    const station = existingDsp.stations[0] ?? await prisma.station.create({
      data: { dspId: existingDsp.id, code: body.stationCode, isPrimary: true },
    })

    const updatedEmployee = await prisma.employee.update({
      where: { id: employee.id },
      data: {
        dspId: existingDsp.id,
        primaryStationId: station.id,
        permissionLevel: 'OWNER',
        status: 'ACTIVE',
      },
    })

    result = { dsp: existingDsp, station, employee: updatedEmployee }
  } else {
    // Normal path: create DSP + Station + update Employee in a transaction
    result = await prisma.$transaction(async (tx) => {
      const dsp = await tx.dsp.create({
        data: {
          name: body.dspName,
          amazonDspId: body.amazonDspCode,
        },
      })

      const station = await tx.station.create({
        data: {
          dspId: dsp.id,
          code: body.stationCode,
          isPrimary: true,
        },
      })

      const updatedEmployee = await tx.employee.update({
        where: { id: employee.id },
        data: {
          dspId: dsp.id,
          primaryStationId: station.id,
          permissionLevel: 'OWNER',
          status: 'ACTIVE',
        },
      })

      return { dsp, station, employee: updatedEmployee }
    })
  }

  await clerkClient.users.updateUserMetadata(userId!, {
    publicMetadata: { dspId: result.dsp.id, role: 'OWNER' },
  })

  res.json(result)
}
