import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { prisma } from '../lib/prisma'

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { id: true, dspId: true },
  })
}

// ─── GET /api/notifications/my ──────────────────────────────────────────────

export async function getMyNotifications(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await resolveEmployee(userId)
  if (!employee || !employee.dspId) {
    res.json({ notifications: [], total: 0, page: 1, limit: 20 }); return
  }

  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
  const skip = (page - 1) * limit

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where: { employeeId: employee.id, dspId: employee.dspId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({
      where: { employeeId: employee.id, dspId: employee.dspId },
    }),
  ])

  res.json({ notifications, total, page, limit })
}

// ─── GET /api/notifications/my/unread-count ──────────────────────────────────

export async function getUnreadCount(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await resolveEmployee(userId)
  if (!employee || !employee.dspId) {
    res.json({ count: 0 }); return
  }

  const count = await prisma.notification.count({
    where: { employeeId: employee.id, dspId: employee.dspId, readAt: null },
  })

  res.json({ count })
}

// ─── POST /api/notifications/:id/read ───────────────────────────────────────

export async function markRead(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await resolveEmployee(userId)
  if (!employee || !employee.dspId) {
    res.status(403).json({ message: 'Forbidden' }); return
  }

  const notification = await prisma.notification.findFirst({
    where: { id: String(req.params.id), employeeId: employee.id, dspId: employee.dspId },
  })
  if (!notification) {
    res.status(404).json({ message: 'Notification not found' }); return
  }

  await prisma.notification.update({
    where: { id: notification.id },
    data: { readAt: new Date() },
  })

  res.json({ success: true })
}

// ─── POST /api/notifications/read-all ───────────────────────────────────────

export async function markAllRead(req: Request, res: Response) {
  const { userId } = getAuth(req)
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return }

  const employee = await resolveEmployee(userId)
  if (!employee || !employee.dspId) {
    res.status(403).json({ message: 'Forbidden' }); return
  }

  await prisma.notification.updateMany({
    where: { employeeId: employee.id, dspId: employee.dspId, readAt: null },
    data: { readAt: new Date() },
  })

  res.json({ success: true })
}
