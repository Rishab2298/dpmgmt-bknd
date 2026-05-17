import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getMyNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
} from '../controllers/notifications.controller'

const router = Router()

router.use(requireAuth())

router.get('/my', getMyNotifications)
router.get('/my/unread-count', getUnreadCount)
router.post('/:id/read', markRead)
router.post('/read-all', markAllRead)

export default router
