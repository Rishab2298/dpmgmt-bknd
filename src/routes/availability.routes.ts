import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getMyAvailability, submitAvailability, getStationAvailability } from '../controllers/availability.controller'

const router = Router()

router.use(requireAuth())

router.get('/me', getMyAvailability)
router.put('/me', submitAvailability)
router.get('/', getStationAvailability)

export default router
