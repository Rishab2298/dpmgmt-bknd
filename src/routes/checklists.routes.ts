import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  updateChecklist,
  deleteChecklist,
  addChecklistItem,
} from '../controllers/checklists.controller'

const router = Router()
router.use(requireAuth())

router.patch('/:id', updateChecklist)
router.delete('/:id', deleteChecklist)
router.post('/:id/items', addChecklistItem)

export default router
