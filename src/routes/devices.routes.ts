import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getDevice,
  updateDevice,
  deleteDevice,
  listDeviceLogs,
} from '../controllers/devices.controller'

const router = Router()

router.use(requireAuth())

router.get('/:id', getDevice)
router.patch('/:id', updateDevice)
router.delete('/:id', deleteDevice)
router.get('/:id/logs', listDeviceLogs)

export default router
