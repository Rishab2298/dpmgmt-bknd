import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { getStation, updateStation } from '../controllers/stations.controller'
import { getLoadOutTemplate, updateLoadOutTemplate } from '../controllers/loadout.controller'
import {
  listStationQualifications, setStationQualificationRate,
  listVehicleGroups, createVehicleGroup, updateVehicleGroup, deleteVehicleGroup,
  listRateCards, createRateCard, updateRateCard, deleteRateCard,
  listInvoiceTypes, createInvoiceType, updateInvoiceType, deleteInvoiceType,
  listShiftTypes, createShiftType, updateShiftType, deleteShiftType,
} from '../controllers/station-resources.controller'
import {
  listStationVehicleTypes, createStationVehicleType,
  updateStationVehicleType, deleteStationVehicleType,
} from '../controllers/station-vehicle-types.controller'
import { getNotificationConfig, upsertNotificationConfig } from '../controllers/notification-config.controller'
import {
  listStationMap,
  createReferenceLocation, updateReferenceLocation, deleteReferenceLocation,
  createStagingLocation, updateStagingLocation, deleteStagingLocation,
  moveStagingLocation,
  importStationMap, importStationMapFile, stationMapUploadMiddleware,
} from '../controllers/station-map.controller'

const router = Router()

router.use(requireAuth())

// Station settings
router.get('/:id', getStation)
router.patch('/:id', updateStation)

// Qualification rates (qualifications are DSP-global; this manages per-station rates)
router.get('/:id/qualifications', listStationQualifications)
router.patch('/:id/qualifications/:qualId', setStationQualificationRate)

// Vehicle Types (station-specific user-managed list)
router.get('/:id/vehicle-types', listStationVehicleTypes)
router.post('/:id/vehicle-types', createStationVehicleType)
router.patch('/:id/vehicle-types/:typeId', updateStationVehicleType)
router.delete('/:id/vehicle-types/:typeId', deleteStationVehicleType)

// Vehicle Groups
router.get('/:id/vehicle-groups', listVehicleGroups)
router.post('/:id/vehicle-groups', createVehicleGroup)
router.patch('/:id/vehicle-groups/:groupId', updateVehicleGroup)
router.delete('/:id/vehicle-groups/:groupId', deleteVehicleGroup)

// Rate Cards
router.get('/:id/rate-cards', listRateCards)
router.post('/:id/rate-cards', createRateCard)
router.patch('/:id/rate-cards/:cardId', updateRateCard)
router.delete('/:id/rate-cards/:cardId', deleteRateCard)

// Invoice Types
router.get('/:id/invoice-types', listInvoiceTypes)
router.post('/:id/invoice-types', createInvoiceType)
router.patch('/:id/invoice-types/:typeId', updateInvoiceType)
router.delete('/:id/invoice-types/:typeId', deleteInvoiceType)

// Shift Types
router.get('/:id/shift-types', listShiftTypes)
router.post('/:id/shift-types', createShiftType)
router.patch('/:id/shift-types/:shiftTypeId', updateShiftType)
router.delete('/:id/shift-types/:shiftTypeId', deleteShiftType)

// Load Out Template (per station)
router.get('/:id/loadout-template', getLoadOutTemplate)
router.patch('/:id/loadout-template', updateLoadOutTemplate)

// RTS Template (per station)
import { getRTSTemplate, updateRTSTemplate } from '../controllers/rts.controller'
router.get('/:id/rts-template', getRTSTemplate)
router.patch('/:id/rts-template', updateRTSTemplate)

// Notification Config
router.get('/:id/notification-config', getNotificationConfig)
router.put('/:id/notification-config/:type', upsertNotificationConfig)

// Station Map
router.get('/:id/station-map', listStationMap)
router.post('/:id/station-map/reference-locations', createReferenceLocation)
router.patch('/:id/station-map/reference-locations/:refId', updateReferenceLocation)
router.delete('/:id/station-map/reference-locations/:refId', deleteReferenceLocation)
router.post('/:id/station-map/reference-locations/:refId/staging-locations', createStagingLocation)
router.patch('/:id/station-map/staging-locations/:stagingId', updateStagingLocation)
router.delete('/:id/station-map/staging-locations/:stagingId', deleteStagingLocation)
router.patch('/:id/station-map/staging-locations/:stagingId/move', moveStagingLocation)
router.post('/:id/station-map/import', importStationMap)
router.post('/:id/station-map/import-file', stationMapUploadMiddleware, importStationMapFile)

export default router
