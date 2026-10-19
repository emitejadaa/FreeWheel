import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AntifraudeService } from "./antifraude.service";

/**
 * El control de reputación inflada.
 *
 * EXPORTA EL SERVICIO. Lo usan reseñas y publicaciones, que son los dos lugares
 * donde se puede fabricar un perfil, y el panel de administración para leer la
 * bandeja de señales. Un módulo que no exporta lo que otros usan compila
 * perfecto y falla al levantar el servidor; de eso se ocupa la prueba del grafo
 * (src/app.module.spec.ts).
 *
 * AuditLogService llega por el módulo global de common.
 */
@Module({
  imports: [PrismaModule],
  providers: [AntifraudeService],
  exports: [AntifraudeService],
})
export class AntifraudeModule {}
