import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  getVehicle,
  updateVehicle,
  deleteVehicle,
  listVehicleLogs,
  listVehicleImages,
  listVehicleInspections,
  uploadVehicleImage,
  deleteVehicleImage,
  imageUploadMiddleware,
  createServicePeriod,
  deleteServicePeriod,
} from '../controllers/vehicles.controller'

const router = Router()
router.use(requireAuth())

router.get('/:id', getVehicle)
router.patch('/:id', updateVehicle)
router.delete('/:id', deleteVehicle)
router.get('/:id/logs', listVehicleLogs)
router.get('/:id/images', listVehicleImages)
router.get('/:id/inspections', listVehicleInspections)
router.post('/:id/images', imageUploadMiddleware, uploadVehicleImage)
router.delete('/:id/images/:imageId', deleteVehicleImage)
router.post('/:id/service-periods', createServicePeriod)
router.delete('/:id/service-periods/:periodId', deleteServicePeriod)

export default router
