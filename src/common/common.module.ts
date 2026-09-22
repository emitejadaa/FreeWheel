import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuditLogService } from "./services/audit-log.service";
import { EncryptionService } from "./crypto/encryption.service";

/**
 * Global porque el cifrado lo necesitan módulos que no tienen nada que ver
 * entre sí (contratos, reservas, verificación de vehículos): importarlo en cada
 * uno es una línea que alguien se olvida, y el síntoma sería un error de
 * inyección en runtime en vez de uno de compilación.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuditLogService, EncryptionService],
  exports: [AuditLogService, EncryptionService],
})
export class CommonModule {}
