/**
 * Dev seed — reconstructs a DSP + station + employee after a DB reset.
 *
 * Usage:
 *   npm run db:seed -- user_xxxxxxxxxxxxxxxxxx
 *   SEED_CLERK_USER_ID=user_xxx npm run db:seed
 *
 * Find your Clerk userId at https://dashboard.clerk.com → Users → click your user.
 */
import { config } from 'dotenv'
import { resolve } from 'path'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

config({ path: resolve(__dirname, '../.env') })

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL as string })
const prisma = new PrismaClient({ adapter })

async function main() {
  const clerkUserId = process.env.SEED_CLERK_USER_ID ?? process.argv[2]
  if (!clerkUserId) {
    throw new Error(
      'Provide your Clerk userId:\n  npm run db:seed -- user_xxx\n  SEED_CLERK_USER_ID=user_xxx npm run db:seed'
    )
  }

  console.log(`Seeding for Clerk user: ${clerkUserId}`)

  const dsp = await prisma.dsp.upsert({
    where: { amazonDspId: 'DXX1' },
    create: { name: 'Dev DSP', amazonDspId: 'DXX1' },
    update: {},
  })
  console.log(`DSP: ${dsp.name} (${dsp.id})`)

  const station = await prisma.station.upsert({
    where: { dspId_code: { dspId: dsp.id, code: 'DAX1' } },
    create: { dspId: dsp.id, code: 'DAX1', name: 'Dev Station', isPrimary: true },
    update: {},
  })
  console.log(`Station: ${station.code} (${station.id})`)

  const employee = await prisma.employee.upsert({
    where: { clerkUserId },
    create: {
      clerkUserId,
      legalFirstName: 'Dev',
      legalLastName: 'User',
      workEmail: `dev+${clerkUserId}@dspmgmt.local`,
      dspId: dsp.id,
      primaryStationId: station.id,
      permissionLevel: 'OWNER',
      status: 'ACTIVE',
    },
    update: {
      dspId: dsp.id,
      primaryStationId: station.id,
      permissionLevel: 'OWNER',
      status: 'ACTIVE',
    },
  })
  console.log(`Employee: ${employee.legalFirstName} ${employee.legalLastName} (${employee.id})`)
  console.log('Done.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
