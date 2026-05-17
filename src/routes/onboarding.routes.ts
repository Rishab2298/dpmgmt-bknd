import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getMe, updatePersonal, completeOnboarding } from '../controllers/onboarding.controller'

const router = Router()

router.use(requireAuth())

router.get('/me', getMe)
router.patch('/personal', updatePersonal)
router.post('/complete', completeOnboarding)

export default router
