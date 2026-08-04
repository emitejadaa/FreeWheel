import { PrismaService } from "../../src/prisma/prisma.service";

/**
 * Deletes every row in FK-safe order (all relations use onDelete: Restrict, so
 * dependents must go before their parents). Called in each spec's beforeEach so
 * tests are independent. Only ever runs against the guarded test database.
 */
export async function cleanDatabase(prisma: PrismaService): Promise<void> {
  await prisma.review.deleteMany();
  await prisma.report.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.mediaAsset.deleteMany();
  await prisma.stripeEvent.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.paymentRecord.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.listingAvailabilityBlock.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.verificationCode.deleteMany();
  await prisma.userVerification.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.user.deleteMany();
  await prisma.pendingRegistration.deleteMany();
}
