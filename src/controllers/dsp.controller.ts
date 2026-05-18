import { Request, Response } from 'express'
import { randomBytes } from 'crypto'
import { getAuth } from '@clerk/express'
import { prisma } from '../lib/prisma'

// GET /api/dsp/stations
export async function getDspStations(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: { dspId: true, primaryStationId: true },
  })

  if (!employee?.dspId) {
    res.status(404).json({ error: 'No DSP found for this user' })
    return
  }

  const dsp = await prisma.dsp.findUnique({
    where: { id: employee.dspId },
    select: { amazonDspId: true },
  })

  const stations = await prisma.station.findMany({
    where: { dspId: employee.dspId },
    select: { id: true, code: true, name: true, isPrimary: true, address: true, timezone: true },
    orderBy: { isPrimary: 'desc' },
  })

  res.json({ stations, primaryStationId: employee.primaryStationId, amazonDspId: dsp?.amazonDspId ?? null })
}

// GET /api/dsp/skills
export async function getDspSkills(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: { dspId: true },
  })
  if (!employee?.dspId) { res.status(404).json({ error: 'No DSP found for this user' }); return }
  const skills = await prisma.skill.findMany({
    where: { dspId: employee.dspId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  res.json(skills)
}

// GET /api/dsp/shift-types?stationId=
export async function getShiftTypes(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const { stationId } = req.query as Record<string, string>

  if (!stationId) {
    res.status(400).json({ message: 'stationId is required' })
    return
  }

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: { dspId: true },
  })

  if (!employee?.dspId) {
    res.status(404).json({ error: 'No DSP found' })
    return
  }

  const shiftTypes = await prisma.shiftType.findMany({
    where: { stationId },
    select: {
      id: true, name: true, color: true, durationMinutes: true, breakMinutes: true,
      invoiceType: { select: { id: true, name: true, billableHours: true } },
      vehicleGroup: {
        select: {
          id: true,
          vehicleTypes: { select: { stationVehicleTypeId: true } },
        },
      },
    },
    orderBy: { name: 'asc' },
  })

  res.json(shiftTypes)
}

// POST /api/dsp/extension-token — generate (or return existing) long-lived token for Chrome extension
export async function getExtensionToken(req: Request, res: Response) {
  const { userId } = getAuth(req)

  const employee = await prisma.employee.findUnique({
    where: { clerkUserId: userId! },
    select: { dspId: true, permissionLevel: true },
  })

  if (!employee?.dspId) {
    res.status(404).json({ error: 'No DSP found for this user' })
    return
  }

  if (employee.permissionLevel !== 'OWNER' && employee.permissionLevel !== 'OPERATIONS_ACCOUNT_MANAGER' && employee.permissionLevel !== 'OPERATIONS_MANAGER') {
    res.status(403).json({ error: 'Only owners and managers can generate extension tokens' })
    return
  }

  const dsp = await prisma.dsp.findUnique({
    where: { id: employee.dspId },
    select: { extensionToken: true },
  })

  // Return existing token if one exists, otherwise generate a new one
  let token = dsp?.extensionToken
  if (!token) {
    token = `ext_${randomBytes(32).toString('hex')}`
    await prisma.dsp.update({
      where: { id: employee.dspId },
      data: { extensionToken: token },
    })
  }

  res.json({ extensionToken: token })
}
