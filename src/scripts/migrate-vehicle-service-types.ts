/**
 * migrate-vehicle-service-types.ts
 *
 * One-time migration: converts old `serviceType VehicleType` enum values to
 * `stationVehicleTypeId` FK references in `StationVehicleType`.
 *
 * NOTE: This script is only useful if you are restoring from a backup that
 * still has the old `serviceType` column. After running `prisma db push` with
 * the updated schema, that column has already been dropped from the live DB.
 *
 * To run (from backend/):
 *   npx ts-node src/scripts/migrate-vehicle-service-types.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const ENUM_TO_NAME: Record<string, string> = {
  STANDARD_PARCEL_ELECTRIC_RIVIAN_MEDIUM: 'Standard Parcel Electric - Rivian Medium',
  STANDARD_PARCEL_EXTRA_LARGE_VAN:        'Standard Parcel - Extra Large Van',
  STANDARD_PARCEL_CDV_14FT:               'Standard Parcel - CDV 14ft',
  STANDARD_PARCEL_CDV_12FT:               'Standard Parcel - CDV 12ft',
}

async function main() {
  // Query vehicles that still have no stationVehicleTypeId (i.e. unmigrated)
  // In a backup-restore scenario, you would join against the old serviceType column.
  // Since the column no longer exists in the Prisma schema, this script serves
  // as documentation of the migration intent.
  console.log('Migration script: migrate-vehicle-service-types')
  console.log('')
  console.log('This script was designed to convert old VehicleType enum values')
  console.log('to StationVehicleType FK references.')
  console.log('')
  console.log('If you are restoring from a pre-migration backup, you will need to:')
  console.log('1. Temporarily re-add `serviceType VehicleType` to the Vehicle model')
  console.log('2. Run db push to restore the column')
  console.log('3. Re-run this script with the actual migration logic enabled')
  console.log('')
  console.log('Enum → display name mapping for reference:')
  for (const [enumVal, displayName] of Object.entries(ENUM_TO_NAME)) {
    console.log(`  ${enumVal} → "${displayName}"`)
  }
  console.log('')

  // Count vehicles with no stationVehicleTypeId
  const untyped = await prisma.vehicle.count({ where: { stationVehicleTypeId: null } })
  const total   = await prisma.vehicle.count()
  console.log(`Current state: ${total} total vehicles, ${untyped} without a stationVehicleTypeId`)

  if (untyped > 0) {
    console.log('')
    console.log(`To assign service types to existing vehicles, use the edit form in the`)
    console.log(`Vehicles page — the Service Type dropdown now loads from the station's list.`)
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
