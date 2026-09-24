-- Mercado Pago: la cuenta del dueño vinculada por OAuth (split de pagos).
--
-- Todo aditivo, y con IF NOT EXISTS: esta base se creó con `db push` y el
-- deploy puede elegir cualquiera de los dos caminos (ver scripts/deploy-migrate.js).
--
-- Los renombres del schema (providerPaymentId, checkoutPaymentId,
-- depositPaymentId, providerRefundId, ProcessorEvent) son `@map` de Prisma:
-- cambian el nombre en el código y NO tocan la base. Las columnas siguen
-- llamándose como en la época de Stripe a propósito.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mpUserId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mpAccessTokenEnc" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mpRefreshTokenEnc" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mpPublicKey" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mpTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mpLinkedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mpLiveMode" BOOLEAN;
CREATE UNIQUE INDEX IF NOT EXISTS "User_mpUserId_key" ON "User"("mpUserId");

ALTER TABLE "PaymentRecord" ADD COLUMN IF NOT EXISTS "collectorId" TEXT;
