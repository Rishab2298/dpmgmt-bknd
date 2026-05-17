import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { updateScheduled, deleteScheduled } from '../controllers/scheduled-maintenance.controller'

const router = Router()
router.use(requireAuth())

router.patch('/:id', updateScheduled)
router.delete('/:id', deleteScheduled)

export default router
