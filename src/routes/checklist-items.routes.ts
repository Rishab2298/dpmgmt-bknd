import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { toggleChecklistItem, deleteChecklistItem } from '../controllers/checklists.controller'

const router = Router()
router.use(requireAuth())

router.patch('/:itemId', toggleChecklistItem)
router.delete('/:itemId', deleteChecklistItem)

export default router
