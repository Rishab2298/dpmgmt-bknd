import cron from 'node-cron'
import { prisma } from '../lib/prisma'

export function startServiceStatusSyncJob() {
  // Runs every hour — reverts IN_REPAIR vehicles to ACTIVE when all service
  // records have passed their completion date
  cron.schedule('0 * * * *', async () => {
    const now = new Date()

    const inRepairVehicles = await prisma.vehicle.findMany({
      where: { status: 'IN_REPAIR' },
      select: { id: true, dspId: true },
    })

    for (const vehicle of inRepairVehicles) {
      const hasActiveRecord = await prisma.vehicleMaintenanceRecord.findFirst({
        where: {
          vehicleId: vehicle.id,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          OR: [{ serviceDate: null }, { serviceDate: { gte: now } }],
        },
      })

      if (!hasActiveRecord) {
        await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status: 'ACTIVE' } })
        await prisma.activityLog.create({
          data: {
            dspId: vehicle.dspId,
            entityType: 'VEHICLE',
            entityId: vehicle.id,
            action: 'Status: IN_REPAIR → ACTIVE (service completion date passed)',
            performedByName: 'System (Auto)',
          },
        })
      }
    }
  })
}
