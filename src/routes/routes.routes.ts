import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getCommitments, saveCommitments, copyWeek } from '../controllers/routes.controller'

const router = Router()

router.use(requireAuth())

router.get('/commitments', getCommitments)
router.post('/commitments/save', saveCommitments)
router.post('/commitments/copy-week', copyWeek)

export default router
