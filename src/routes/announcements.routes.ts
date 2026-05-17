import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getMyAnnouncements,
  markRead,
  getUnreadCount,
} from '../controllers/announcements.controller'

const router = Router()
router.use(requireAuth())

router.get('/my', getMyAnnouncements)
router.get('/my/unread-count', getUnreadCount)
router.post('/:id/read', markRead)

export default router
