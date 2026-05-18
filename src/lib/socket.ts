import { Server as SocketIOServer, Socket } from 'socket.io'
import { Server as HttpServer } from 'http'
import { verifyToken } from '@clerk/express'
import { prisma } from './prisma'

// ─── Types ───────────────────────────────────────────────────────────────────

interface SocketData {
  employeeId: string
  dspId: string
  permissionLevel: string
}

interface NewConversationPayload {
  id: string
  type: string
  name: string | null
  updatedAt: Date
  lastMessage: null
  unreadCount: number
  participants: Array<{
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
    isOnline: boolean
  }>
  otherParticipant: {
    id: string
    legalFirstName: string
    legalLastName: string
    nickname: string | null
    permissionLevel: string
    title: string | null
  } | null
}

interface ServerToClientEvents {
  'conv:message': (msg: ChatMessage) => void
  'conv:new': (payload: NewConversationPayload) => void
  'conv:typing': (payload: { conversationId: string; employeeId: string; isTyping: boolean }) => void
  'conv:read:update': (payload: { conversationId: string; employeeId: string; lastReadAt: string }) => void
  'conv:message:deleted': (payload: { messageId: string; conversationId: string; deletedAt: string }) => void
  'conv:update': (payload: { conversationId: string; name: string }) => void
  'conv:removed': (payload: { conversationId: string }) => void
  'notification:new': (payload: { id: string; type: string; title: string; message: string; severity: string; createdAt: string }) => void
  'broadcast:new': (payload: { instanceId: string; title: string; body: string; hasTemplate: boolean; sentAt: string }) => void
  'presence:online': (payload: { employeeId: string }) => void
  'presence:offline': (payload: { employeeId: string }) => void
  'presence:snapshot': (payload: { onlineIds: string[]; myEmployeeId: string }) => void
  'error': (payload: { message: string }) => void
}

interface ClientToServerEvents {
  'conv:join': (payload: { conversationId: string }) => void
  'conv:send': (payload: { conversationId: string; body: string }) => void
  'conv:typing:start': (payload: { conversationId: string }) => void
  'conv:typing:stop': (payload: { conversationId: string }) => void
  'conv:read': (payload: { conversationId: string }) => void
}

interface ChatMessage {
  id: string
  conversationId: string
  senderId: string
  senderName: string
  body: string
  sentAt: string
}

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>

// ─── In-memory presence store ─────────────────────────────────────────────────
// Map<dspId, Set<employeeId>> — reset on server restart; clients rebuild via snapshot

export const onlineByDsp = new Map<string, Set<string>>()

// ─── Shared IO instance ───────────────────────────────────────────────────────
// Exported so controllers can emit events (e.g. conv:new on conversation creation)

let _io: SocketIOServer<ClientToServerEvents, ServerToClientEvents> | null = null

export function getIO() {
  return _io
}

// ─── Setup ────────────────────────────────────────────────────────────────────

export function setupSocketServer(httpServer: HttpServer) {
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL ?? 'http://localhost:5173',
      credentials: true,
    },
  })
  _io = io

  // ── Auth middleware ──────────────────────────────────────────────────────────

  io.use(async (socket: AppSocket, next) => {
    const token = socket.handshake.auth?.token as string | undefined
    if (!token) return next(new Error('Unauthorized'))

    try {
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY })
      if (!payload?.sub) return next(new Error('Unauthorized'))

      const employee = await prisma.employee.findUnique({
        where: { clerkUserId: payload.sub },
        select: { id: true, dspId: true, permissionLevel: true, status: true },
      })

      if (!employee || !employee.dspId) return next(new Error('Unauthorized'))
      if (employee.status === 'TERMINATED' || employee.status === 'OFFBOARDED') {
        return next(new Error('Account inactive'))
      }

      socket.data.employeeId = employee.id
      socket.data.dspId = employee.dspId
      socket.data.permissionLevel = employee.permissionLevel
      next()
    } catch {
      next(new Error('Unauthorized'))
    }
  })

  // ── Unhandled socket errors ──────────────────────────────────────────────────

  io.on('error', (err) => {
    console.error('[socket] server error:', err)
  })

  // ── Connection handler ───────────────────────────────────────────────────────

  io.on('connection', async (socket: AppSocket) => {
    const { employeeId, dspId } = socket.data

    socket.on('error', (err) => {
      console.error(`[socket] error for employee ${employeeId}:`, err)
    })

    // 1. Add to presence store
    if (!onlineByDsp.has(dspId)) onlineByDsp.set(dspId, new Set())
    onlineByDsp.get(dspId)!.add(employeeId)

    // 2. Join personal + DSP rooms
    await socket.join(`emp:${employeeId}`)
    await socket.join(`dsp:${dspId}`)

    // 3. Auto-join all active conversation rooms
    const participations = await prisma.conversationParticipant.findMany({
      where: { employeeId, leftAt: null },
      select: { conversationId: true },
    })
    for (const p of participations) {
      await socket.join(`conv:${p.conversationId}`)
    }

    // 4. Send current online snapshot + own employee ID to this socket only
    socket.emit('presence:snapshot', {
      onlineIds: [...(onlineByDsp.get(dspId) ?? [])],
      myEmployeeId: employeeId,
    })

    // 5. Broadcast that this employee is online to others in the DSP
    socket.to(`dsp:${dspId}`).emit('presence:online', { employeeId })

    // ── Event: join a conversation room ───────────────────────────────────────

    socket.on('conv:join', async ({ conversationId }) => {
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_employeeId: { conversationId, employeeId } },
      })
      if (!participant || participant.leftAt !== null) {
        socket.emit('error', { message: 'Not a participant in this conversation' })
        return
      }
      await socket.join(`conv:${conversationId}`)
    })

    // ── Event: send a message ─────────────────────────────────────────────────

    socket.on('conv:send', async ({ conversationId, body }) => {
      const trimmed = body?.trim()
      if (!trimmed || trimmed.length > 4000) {
        socket.emit('error', { message: 'Invalid message body' })
        return
      }

      // Verify the sender is an active participant
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_employeeId: { conversationId, employeeId } },
      })
      if (!participant || participant.leftAt !== null) {
        socket.emit('error', { message: 'Not a participant in this conversation' })
        return
      }

      // Save message + bump conversation.updatedAt atomically
      const sender = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { legalFirstName: true, legalLastName: true, nickname: true },
      })
      const senderName = sender?.nickname
        ?? `${sender?.legalFirstName ?? ''} ${sender?.legalLastName ?? ''}`.trim()

      const [message] = await prisma.$transaction([
        prisma.message.create({
          data: { conversationId, senderId: employeeId, body: trimmed },
        }),
        prisma.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        }),
      ])

      const chatMsg: ChatMessage = {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        senderName,
        body: message.body,
        sentAt: message.sentAt.toISOString(),
      }

      // Emit to all connected participants in the room
      io.to(`conv:${conversationId}`).emit('conv:message', chatMsg)

      // Also notify offline participants via their personal room
      const allParticipants = await prisma.conversationParticipant.findMany({
        where: { conversationId, leftAt: null },
        select: { employeeId: true },
      })
      const socketsInRoom = await io.in(`conv:${conversationId}`).fetchSockets()
      const connectedEmployeeIds = new Set(socketsInRoom.map((s) => s.data.employeeId))

      for (const p of allParticipants) {
        if (!connectedEmployeeIds.has(p.employeeId)) {
          io.to(`emp:${p.employeeId}`).emit('conv:message', chatMsg)
        }
      }
    })

    // ── Event: typing indicators ───────────────────────────────────────────────

    socket.on('conv:typing:start', ({ conversationId }) => {
      if (!socket.rooms.has(`conv:${conversationId}`)) return
      socket.to(`conv:${conversationId}`).emit('conv:typing', {
        conversationId,
        employeeId,
        isTyping: true,
      })
    })

    socket.on('conv:typing:stop', ({ conversationId }) => {
      if (!socket.rooms.has(`conv:${conversationId}`)) return
      socket.to(`conv:${conversationId}`).emit('conv:typing', {
        conversationId,
        employeeId,
        isTyping: false,
      })
    })

    // ── Event: mark conversation as read ──────────────────────────────────────

    socket.on('conv:read', async ({ conversationId }) => {
      const participant = await prisma.conversationParticipant.findUnique({
        where: { conversationId_employeeId: { conversationId, employeeId } },
      })
      if (!participant || participant.leftAt !== null) return

      const now = new Date()
      const prevReadAt = participant.lastReadAt ?? new Date(0)

      // Atomically: update lastReadAt + create MessageRead rows for unread messages
      await prisma.$transaction(async (tx) => {
        await tx.conversationParticipant.update({
          where: { conversationId_employeeId: { conversationId, employeeId } },
          data: { lastReadAt: now },
        })

        const unread = await tx.message.findMany({
          where: {
            conversationId,
            sentAt: { gt: prevReadAt },
            senderId: { not: employeeId },
            deletedAt: null,
          },
          select: { id: true },
        })

        if (unread.length > 0) {
          await tx.messageRead.createMany({
            data: unread.map((m) => ({
              messageId: m.id,
              readByEmployeeId: employeeId,
              readAt: now,
            })),
            skipDuplicates: true,
          })
        }
      })

      // Broadcast read update to others in the conversation
      socket.to(`conv:${conversationId}`).emit('conv:read:update', {
        conversationId,
        employeeId,
        lastReadAt: now.toISOString(),
      })
    })

    // ── Disconnect ─────────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      const dspSet = onlineByDsp.get(dspId)
      if (dspSet) {
        dspSet.delete(employeeId)
        if (dspSet.size === 0) onlineByDsp.delete(dspId)  // GC empty sets
      }
      socket.to(`dsp:${dspId}`).emit('presence:offline', { employeeId })
    })
  })

  return io
}
