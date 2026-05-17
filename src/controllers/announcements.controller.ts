import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { prisma } from '../lib/prisma'

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { transporterId: true, dspId: true },
  })
}

// ─── Get my announcements ───────────────────────────────────────────────────

export async function getMyAnnouncements(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await resolveEmployee(userId)
  if (!employee || !employee.transporterId || !employee.dspId) {
    res.json({ announcements: [] }); return
  }

  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
  const skip = (page - 1) * limit

  const [announcements, total] = await Promise.all([
    prisma.announcement.findMany({
      where: {
        transporterId: { equals: employee.transporterId, mode: 'insensitive' },
        dspId: employee.dspId,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        week: {
          select: { weekNumber: true, year: true, weekStart: true, weekEnd: true },
        },
      },
    }),
    prisma.announcement.count({
      where: {
        transporterId: { equals: employee.transporterId, mode: 'insensitive' },
        dspId: employee.dspId,
      },
    }),
  ])

  res.json({ announcements, total, page, limit })
}

// ─── Mark as read ───────────────────────────────────────────────────────────

export async function markRead(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await resolveEmployee(userId)
  if (!employee || !employee.transporterId || !employee.dspId) {
    res.status(403).json({ message: 'Forbidden' }); return
  }

  const announcement = await prisma.announcement.findFirst({
    where: {
      id: String(req.params.id),
      transporterId: { equals: employee.transporterId, mode: 'insensitive' },
      dspId: employee.dspId,
    },
  })
  if (!announcement) { res.status(404).json({ message: 'Not found' }); return }

  await prisma.announcement.update({
    where: { id: announcement.id },
    data: { readAt: new Date() },
  })

  res.json({ success: true })
}

// ─── Unread count ───────────────────────────────────────────────────────────

export async function getUnreadCount(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await resolveEmployee(userId)
  if (!employee || !employee.transporterId || !employee.dspId) {
    res.json({ count: 0 }); return
  }

  const count = await prisma.announcement.count({
    where: {
      transporterId: { equals: employee.transporterId, mode: 'insensitive' },
      dspId: employee.dspId,
      readAt: null,
    },
  })

  res.json({ count })
}
