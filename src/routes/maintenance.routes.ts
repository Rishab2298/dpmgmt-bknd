import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getMaintenanceRecord,
  updateMaintenanceRecord,
  deleteMaintenanceRecord,
  uploadMaintenanceAttachment,
  maintenanceUploadMiddleware,
} from '../controllers/maintenance.controller'

const router = Router()
router.use(requireAuth())

router.get('/:id', getMaintenanceRecord)
router.patch('/:id', updateMaintenanceRecord)
router.delete('/:id', deleteMaintenanceRecord)
router.post('/:id/attachment', maintenanceUploadMiddleware, uploadMaintenanceAttachment)

export default router
