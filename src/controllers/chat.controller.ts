import { Request, Response } from 'express'
import { getAuth } from '@clerk/express'
import { z } from 'zod'
import { Prisma, PermissionLevel } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { onlineByDsp, getIO } from '../lib/socket'

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function resolveEmployee(userId: string) {
  return prisma.employee.findUnique({
    where: { clerkUserId: userId },
    select: { id: true, dspId: true, permissionLevel: true },
  })
}

function isOperator(level: PermissionLevel) {
  return level !== PermissionLevel.DELIVERY_ASSOCIATE
}

async function getParticipant(conversationId: string, employeeId: string) {
  const p = await prisma.conversationParticipant.findUnique({
    where: { conversationId_employeeId: { conversationId, employeeId } },
  })
  if (!p || p.leftAt !== null) return null
  return p
}

async function validateSameDsp(dspId: string, employeeIds: string[]) {
  if (employeeIds.length === 0) return true
  const count = await prisma.employee.count({
    where: { id: { in: employeeIds }, dspId, status: 'ACTIVE', clerkUserId: { not: null } },
  })
  return count === employeeIds.length
}

// ─── Socket notification helper ───────────────────────────────────────────────
// Emits conv:new (full ConversationSummary payload) to specified recipients via
// their personal emp:{id} room. Also joins their connected sockets into the
// conv room so future messages arrive without a conv:join from the client.

type ParticipantInfo = {
  id: string
  employeeId: string
  joinedAt: Date
  leftAt: Date | null
  lastReadAt: Date | null
  employee: {
    id: string
    legalFirstName: string
    legalLastName: string
    nickname: string | null
    permissionLevel: string
    title: string | null
  }
}

async function notifyNewConversation(
  conv: { id: string; type: string; name: string | null; updatedAt: Date },
  allParticipants: ParticipantInfo[],
  recipientEmployeeIds: string[],
  dspId: string,
) {
  const io = getIO()
  if (!io) return
  const onlineSet = onlineByDsp.get(dspId) ?? new Set<string>()

  for (const empId of recipientEmployeeIds) {
    // Join all of this employee's connected sockets into the new conv room
    const sockets = await io.in(`emp:${empId}`).fetchSockets()
    for (const s of sockets) await s.join(`conv:${conv.id}`)

    // Build a ConversationSummary tailored to this recipient
    const summary = {
      id: conv.id,
      type: conv.type,
      name: conv.name,
      updatedAt: conv.updatedAt,
      lastMessage: null,
      unreadCount: 0,
      participants: allParticipants.map((pp) => ({
        id: pp.id,
        employeeId: pp.employeeId,
        joinedAt: pp.joinedAt,
        leftAt: pp.leftAt,
        lastReadAt: pp.lastReadAt,
        employee: pp.employee,
        isOnline: onlineSet.has(pp.employeeId),
      })),
      otherParticipant:
        conv.type === 'DIRECT'
          ? (allParticipants.find((pp) => pp.employeeId !== empId)?.employee ?? null)
          : null,
    }

    io.to(`emp:${empId}`).emit('conv:new', summary)
  }
}

// ─── GET /api/chat/me ─────────────────────────────────────────────────────────

export async function getMe(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me) { res.status(403).json({ message: 'Forbidden' }); return }
  res.json({ employeeId: me.id })
}

// ─── GET /api/chat/contacts ───────────────────────────────────────────────────

export async function getContacts(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const contacts = await prisma.employee.findMany({
    where: {
      dspId: me.dspId,
      id: { not: me.id },
      status: 'ACTIVE',
      chatEnabled: true,
      clerkUserId: { not: null },
    },
    select: {
      id: true,
      legalFirstName: true,
      legalLastName: true,
      nickname: true,
      title: true,
      permissionLevel: true,
      primaryStation: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ legalFirstName: 'asc' }, { legalLastName: 'asc' }],
  })

  res.json(contacts)
}

// ─── GET /api/chat/conversations ─────────────────────────────────────────────

export async function listConversations(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const participations = await prisma.conversationParticipant.findMany({
    where: { employeeId: me.id, leftAt: null },
    select: { conversationId: true, lastReadAt: true },
  })

  const conversationIds = participations.map((p) => p.conversationId)
  const lastReadMap = new Map(participations.map((p) => [p.conversationId, p.lastReadAt]))

  if (conversationIds.length === 0) { res.json([]); return }

  const conversations = await prisma.conversation.findMany({
    where: { id: { in: conversationIds } },
    include: {
      participants: {
        where: { leftAt: null },
        include: {
          employee: {
            select: {
              id: true,
              legalFirstName: true,
              legalLastName: true,
              nickname: true,
              permissionLevel: true,
              title: true,
            },
          },
        },
      },
      messages: {
        orderBy: { sentAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { updatedAt: 'desc' },
  })

  const onlineIds = onlineByDsp.get(me.dspId) ?? new Set<string>()

  // Single query for all unread counts — replaces N separate COUNT calls
  const unreadRows = await prisma.$queryRaw<Array<{ conversationId: string; count: bigint }>>`
    SELECT m."conversationId", COUNT(*) as count
    FROM "Message" m
    INNER JOIN LATERAL (
      SELECT "lastReadAt" FROM "ConversationParticipant"
      WHERE "conversationId" = m."conversationId" AND "employeeId" = ${me.id} AND "leftAt" IS NULL
      LIMIT 1
    ) cp ON true
    WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
      AND m."sentAt" > COALESCE(cp."lastReadAt", '1970-01-01'::timestamp)
      AND m."senderId" != ${me.id}
      AND m."deletedAt" IS NULL
    GROUP BY m."conversationId"
  `
  const unreadMap = new Map(unreadRows.map((r) => [r.conversationId, Number(r.count)]))

  const result = conversations.map((conv) => {
    const lastMsg = conv.messages[0] ?? null
    const otherParticipant =
      conv.type === 'DIRECT'
        ? (conv.participants.find((p) => p.employeeId !== me.id)?.employee ?? null)
        : null

    return {
      id: conv.id,
      type: conv.type,
      name: conv.name,
      updatedAt: conv.updatedAt,
      otherParticipant,
      participants: conv.participants.map((p) => ({
        id: p.id,
        employeeId: p.employeeId,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt,
        lastReadAt: p.lastReadAt,
        employee: p.employee,
        isOnline: onlineIds.has(p.employeeId),
      })),
      lastMessage: lastMsg
        ? {
            id: lastMsg.id,
            body: lastMsg.deletedAt ? null : lastMsg.body,
            sentAt: lastMsg.sentAt,
            senderId: lastMsg.senderId,
          }
        : null,
      unreadCount: unreadMap.get(conv.id) ?? 0,
    }
  })

  res.json(result)
}

// ─── POST /api/chat/conversations ─────────────────────────────────────────────

const createConversationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('DIRECT'),
    participantId: z.string().min(1),
  }),
  z.object({
    type: z.literal('GROUP'),
    name: z.string().min(1).max(50),
    participantIds: z.array(z.string().min(1)).min(1).max(19),
  }),
])

const PARTICIPANT_INCLUDE = {
  include: {
    employee: {
      select: {
        id: true,
        legalFirstName: true,
        legalLastName: true,
        nickname: true,
        permissionLevel: true,
        title: true,
      },
    },
  },
} as const

export async function createConversation(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }
  const dspId = me.dspId

  const parsed = createConversationSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Invalid request' })
    return
  }

  const data = parsed.data

  if (data.type === 'DIRECT') {
    const { participantId } = data
    if (participantId === me.id) {
      res.status(400).json({ message: 'Cannot start a conversation with yourself' })
      return
    }

    const valid = await validateSameDsp(me.dspId, [participantId])
    if (!valid) { res.status(403).json({ message: 'Participant not in your DSP' }); return }

    // Deduplication: targeted query for existing DIRECT between exactly these two employees.
    // Wrapped in a serializable transaction to prevent race-condition duplicates.
    const { conv, alreadyExisted } = await prisma.$transaction(async (tx) => {
      const existing = await tx.conversation.findFirst({
        where: {
          dspId,
          type: 'DIRECT',
          AND: [
            { participants: { some: { employeeId: me.id, leftAt: null } } },
            { participants: { some: { employeeId: participantId, leftAt: null } } },
          ],
        },
        include: { participants: { where: { leftAt: null }, ...PARTICIPANT_INCLUDE } },
      })

      if (existing) return { conv: existing, alreadyExisted: true as const }

      const created = await tx.conversation.create({
        data: {
          dspId,
          type: 'DIRECT',
          createdByEmployeeId: me.id,
          participants: {
            create: [{ employeeId: me.id }, { employeeId: participantId }],
          },
        },
        include: { participants: { ...PARTICIPANT_INCLUDE } },
      })

      return { conv: created, alreadyExisted: false as const }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    if (alreadyExisted) {
      res.status(200).json({ exists: true, conversation: conv })
      return
    }

    // Notify all participants via socket (push full payload, zero client HTTP)
    await notifyNewConversation(
      conv,
      conv.participants,
      conv.participants.map((p) => p.employeeId),
      dspId,
    )

    res.status(201).json({ exists: false, conversation: conv })
    return
  }

  // GROUP
  if (!isOperator(me.permissionLevel as PermissionLevel)) {
    res.status(403).json({ message: 'Only operators can create group conversations' })
    return
  }

  const { name, participantIds } = data
  const validGroup = await validateSameDsp(dspId, participantIds)
  if (!validGroup) { res.status(403).json({ message: 'One or more participants not in your DSP' }); return }

  const uniqueIds = [...new Set([me.id, ...participantIds])]

  const groupConv = await prisma.conversation.create({
    data: {
      dspId,
      type: 'GROUP',
      name,
      createdByEmployeeId: me.id,
      participants: {
        create: uniqueIds.map((id) => ({ employeeId: id })),
      },
    },
    include: { participants: { ...PARTICIPANT_INCLUDE } },
  })

  // Notify all participants via socket (push full payload, zero client HTTP)
  await notifyNewConversation(
    groupConv,
    groupConv.participants,
    groupConv.participants.map((p) => p.employeeId),
    dspId,
  )

  res.status(201).json({ exists: false, conversation: groupConv })
}

// ─── GET /api/chat/conversations/:id ─────────────────────────────────────────

export async function getConversation(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const convId = req.params['id'] as string
  const participant = await getParticipant(convId, me.id)
  if (!participant) { res.status(403).json({ message: 'Not a participant' }); return }

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: {
      participants: {
        where: { leftAt: null },       // exclude removed participants
        include: {
          employee: {
            select: {
              id: true,
              legalFirstName: true,
              legalLastName: true,
              nickname: true,
              permissionLevel: true,
              title: true,
            },
          },
        },
      },
    },
  })
  if (!conv) { res.status(404).json({ message: 'Not found' }); return }

  const onlineIds = onlineByDsp.get(me.dspId) ?? new Set<string>()
  res.json({
    ...conv,
    participants: conv.participants.map((p) => ({
      ...p,
      isOnline: onlineIds.has(p.employeeId),
    })),
  })
}

// ─── PATCH /api/chat/conversations/:id ───────────────────────────────────────

export async function updateConversation(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }
  if (!isOperator(me.permissionLevel as PermissionLevel)) {
    res.status(403).json({ message: 'Operators only' }); return
  }

  const parsed = z.object({ name: z.string().min(1).max(50) }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: 'Name is required' }); return }

  const convId = req.params['id'] as string
  const participant = await getParticipant(convId, me.id)
  if (!participant) { res.status(403).json({ message: 'Not a participant' }); return }

  const conv = await prisma.conversation.findUnique({ where: { id: convId } })
  if (!conv || conv.type !== 'GROUP') {
    res.status(400).json({ message: 'Can only rename group conversations' }); return
  }

  const updated = await prisma.conversation.update({
    where: { id: convId },
    data: { name: parsed.data.name },
  })

  // Broadcast name change to all participants in the room
  getIO()?.to(`conv:${convId}`).emit('conv:update', {
    conversationId: convId,
    name: parsed.data.name,
  })

  res.json(updated)
}

// ─── POST /api/chat/conversations/:id/participants ────────────────────────────

export async function addParticipants(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }
  if (!isOperator(me.permissionLevel as PermissionLevel)) {
    res.status(403).json({ message: 'Operators only' }); return
  }

  const parsed = z.object({
    employeeIds: z.array(z.string().min(1)).min(1),
  }).safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ message: 'employeeIds required' }); return }

  const convId = req.params['id'] as string
  const conv = await prisma.conversation.findUnique({ where: { id: convId } })
  if (!conv || conv.dspId !== me.dspId) { res.status(404).json({ message: 'Not found' }); return }
  if (conv.type !== 'GROUP') { res.status(400).json({ message: 'Can only add members to groups' }); return }

  const valid = await validateSameDsp(me.dspId, parsed.data.employeeIds)
  if (!valid) { res.status(403).json({ message: 'One or more employees not in your DSP' }); return }

  const current = await prisma.conversationParticipant.count({
    where: { conversationId: convId, leftAt: null },
  })
  if (current + parsed.data.employeeIds.length > 20) {
    res.status(400).json({ message: 'Group cannot exceed 20 participants' }); return
  }

  for (const empId of parsed.data.employeeIds) {
    await prisma.conversationParticipant.upsert({
      where: { conversationId_employeeId: { conversationId: convId, employeeId: empId } },
      create: { conversationId: convId, employeeId: empId },
      update: { leftAt: null, joinedAt: new Date() },
    })
  }

  // Fetch full conversation (with all current participants) and notify only the new members
  const updatedConv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: { where: { leftAt: null }, ...PARTICIPANT_INCLUDE } },
  })
  if (updatedConv) {
    await notifyNewConversation(
      updatedConv,
      updatedConv.participants,
      parsed.data.employeeIds,
      me.dspId,
    )
  }

  res.status(204).send()
}

// ─── DELETE /api/chat/conversations/:id/participants/:employeeId ──────────────

export async function removeParticipant(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }
  if (!isOperator(me.permissionLevel as PermissionLevel)) {
    res.status(403).json({ message: 'Operators only' }); return
  }

  const convId = req.params['id'] as string
  const employeeId = req.params['employeeId'] as string
  const conv = await prisma.conversation.findUnique({ where: { id: convId } })
  if (!conv || conv.dspId !== me.dspId) { res.status(404).json({ message: 'Not found' }); return }

  await prisma.conversationParticipant.updateMany({
    where: { conversationId: convId, employeeId },
    data: { leftAt: new Date() },
  })

  // Boot the removed employee's sockets from the conv room + notify them
  const io = getIO()
  if (io) {
    const sockets = await io.in(`emp:${employeeId}`).fetchSockets()
    for (const s of sockets) await s.leave(`conv:${convId}`)
    io.to(`emp:${employeeId}`).emit('conv:removed', { conversationId: convId })
  }

  res.status(204).send()
}

// ─── GET /api/chat/conversations/:id/messages ─────────────────────────────────

export async function listMessages(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const convId = req.params['id'] as string
  const participant = await getParticipant(convId, me.id)
  if (!participant) { res.status(403).json({ message: 'Not a participant' }); return }

  const before = req.query['before'] as string | undefined
  const limit = Math.max(1, Math.min(Number(req.query['limit']) || 50, 100))  // clamp [1, 100]

  // Cursor-based pagination by ID (cuid is time-ordered, avoids missed messages on same-ms sends)
  const messages = await prisma.message.findMany({
    where: {
      conversationId: convId,
      ...(before ? { id: { lt: before } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
    include: {
      sender: {
        select: { id: true, legalFirstName: true, legalLastName: true, nickname: true },
      },
      readReceipts: { select: { readByEmployeeId: true } },
    },
  })

  const hasMore = messages.length > limit
  const page = messages.slice(0, limit).reverse()

  const result = page.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName:
      m.sender.nickname ??
      `${m.sender.legalFirstName} ${m.sender.legalLastName}`.trim(),
    body: m.deletedAt ? null : m.body,
    sentAt: m.sentAt,
    deletedAt: m.deletedAt,
    readBy: m.readReceipts.map((r) => r.readByEmployeeId),
  }))

  res.json({
    messages: result,
    hasMore,
    nextCursor: hasMore ? (page[0]?.id ?? null) : null,
  })
}

// ─── POST /api/chat/conversations/:id/messages ────────────────────────────────

const sendMessageSchema = z.object({
  body: z.string().min(1, 'Message cannot be empty').max(4000, 'Message too long'),
})

export async function sendMessage(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const convId = req.params['id'] as string
  const participant = await getParticipant(convId, me.id)
  if (!participant) { res.status(403).json({ message: 'Not a participant' }); return }

  const parsed = sendMessageSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.errors[0]?.message ?? 'Invalid request' })
    return
  }

  const sender = await prisma.employee.findUnique({
    where: { id: me.id },
    select: { legalFirstName: true, legalLastName: true, nickname: true },
  })
  const senderName =
    sender?.nickname ?? `${sender?.legalFirstName ?? ''} ${sender?.legalLastName ?? ''}`.trim()

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: { conversationId: convId, senderId: me.id, body: parsed.data.body.trim() },
    }),
    prisma.conversation.update({ where: { id: convId }, data: { updatedAt: new Date() } }),
  ])

  res.status(201).json({
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    senderName,
    body: message.body,
    sentAt: message.sentAt,
    readBy: [],
  })
}

// ─── POST /api/chat/conversations/:id/read ────────────────────────────────────

export async function markRead(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const convId = req.params['id'] as string
  const participant = await getParticipant(convId, me.id)
  if (!participant) { res.status(403).json({ message: 'Not a participant' }); return }

  const now = new Date()
  const prevReadAt = participant.lastReadAt ?? new Date(0)

  await prisma.conversationParticipant.update({
    where: { conversationId_employeeId: { conversationId: convId, employeeId: me.id } },
    data: { lastReadAt: now },
  })

  const unread = await prisma.message.findMany({
    where: {
      conversationId: convId,
      sentAt: { gt: prevReadAt },
      senderId: { not: me.id },
      deletedAt: null,
    },
    select: { id: true },
  })

  if (unread.length > 0) {
    await prisma.messageRead.createMany({
      data: unread.map((m) => ({
        messageId: m.id,
        readByEmployeeId: me.id,
        readAt: now,
      })),
      skipDuplicates: true,
    })
  }

  res.status(204).send()
}

// ─── DELETE /api/chat/messages/:messageId ────────────────────────────────────

export async function deleteMessage(req: Request, res: Response) {
  const { userId } = getAuth(req)
  const me = await resolveEmployee(userId!)
  if (!me?.dspId) { res.status(403).json({ message: 'Forbidden' }); return }

  const messageId = req.params['messageId'] as string
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { select: { dspId: true } } },
  })
  if (!message) { res.status(404).json({ message: 'Not found' }); return }

  // DSP boundary check — message must belong to requester's DSP
  if (message.conversation.dspId !== me.dspId) {
    res.status(403).json({ message: 'Forbidden' }); return
  }

  if (message.senderId !== me.id) {
    res.status(403).json({ message: "Cannot delete someone else's message" }); return
  }

  const deletedAt = new Date()
  await prisma.message.update({
    where: { id: messageId },
    data: { deletedAt },
  })

  // Broadcast soft-delete to all participants currently in the conversation room
  getIO()?.to(`conv:${message.conversationId}`).emit('conv:message:deleted', {
    messageId,
    conversationId: message.conversationId,
    deletedAt: deletedAt.toISOString(),
  })

  res.status(204).send()
}
