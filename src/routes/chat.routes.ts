import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getMe,
  getContacts,
  listConversations,
  createConversation,
  getConversation,
  updateConversation,
  addParticipants,
  removeParticipant,
  listMessages,
  sendMessage,
  markRead,
  deleteMessage,
} from '../controllers/chat.controller'

const router = Router()

router.use(requireAuth())

// Identity
router.get('/me', getMe)

// Contacts
router.get('/contacts', getContacts)

// Conversations
router.get('/conversations', listConversations)
router.post('/conversations', createConversation)
router.get('/conversations/:id', getConversation)
router.patch('/conversations/:id', updateConversation)
router.post('/conversations/:id/participants', addParticipants)
router.delete('/conversations/:id/participants/:employeeId', removeParticipant)

// Messages
router.get('/conversations/:id/messages', listMessages)
router.post('/conversations/:id/messages', sendMessage)
router.post('/conversations/:id/read', markRead)

// Individual message actions
router.delete('/messages/:messageId', deleteMessage)

export default router
