import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminVehicleVerificationController } from "./admin-vehicle-verification.controller";
import { VehicleDocumentsService } from "./vehicle-documents.service";
import { VehicleVerificationController } from "./vehicle-verification.controller";
import { VehicleVerificationService } from "./vehicle-verification.service";

/**
 * Verificación de que un auto es de quien lo publica: la cédula, el titular y
 * el seguro, revisados por un admin.
 *
 * Exporta solo VehicleVerificationService, que es lo que necesitan publicar y
 * reservar (`assertVehicleVerified`). No importa ListingsModule ni
 * BookingsModule: son ellos los que dependen de este, y al revés sería un
 * ciclo.
 *
 * EncryptionService y AuditLogService llegan por CommonModule, que es global.
 */
@Module({
  imports: [PrismaModule, MediaModule],
  controllers: [
    VehicleVerificationController,
    AdminVehicleVerificationController,
  ],
  providers: [VehicleVerificationService, VehicleDocumentsService],
  exports: [VehicleVerificationService],
})
export class VehicleVerificationModule {}
