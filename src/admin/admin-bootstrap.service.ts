import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserRole, UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../common/services/audit-log.service";
import { normalizeEmail } from "../common/utils/email.util";

/**
 * QUIÉN ES ADMINISTRADOR, Y CÓMO LLEGA A SERLO LA PRIMERA VEZ.
 *
 * `PATCH /admin/users/:id/role` deja a un admin nombrar a otro, pero eso tiene
 * un problema de arranque evidente: si no hay ningún admin, nadie puede
 * nombrar al primero. Hasta ahora la respuesta era entrar a la base a mano, lo
 * cual significa que en cada deploy nuevo el panel arranca inaccesible y que
 * la única forma de destrabarlo es tener las credenciales de la base.
 *
 * Esto lo resuelve: `ADMIN_EMAILS` nombra las cuentas que tienen que ser
 * administradoras, y al levantar el servidor se aplica.
 *
 * ── Por qué una variable y no un mail escrito acá ───────────────────────────
 * Este repositorio es público. Un mail hardcodeado publicaría cuál es la
 * cuenta con control total de la plataforma, que es exactamente la dirección
 * que alguien necesitaría para intentar entrar. Además, así un deploy que no
 * define la variable no tiene ningún administrador automático: lo seguro es el
 * estado por omisión, y abrirlo es un acto explícito en un panel.
 *
 * ── Qué hace y qué NO hace ──────────────────────────────────────────────────
 * Promueve a ADMIN las cuentas que ya existen y están activas. No crea cuentas
 * —una cuenta administradora sin dueño real sería una puerta abierta sin nadie
 * que la vigile—, así que la persona se registra normalmente y en el próximo
 * arranque queda promovida. Y NO DEGRADA a nadie: sacar el rol es una decisión
 * que se toma en el panel, con su registro de auditoría, y no algo que pase
 * solo porque alguien editó una variable de entorno.
 *
 * Todo queda en AuditLog: un cambio de rol que no deja rastro es un cambio de
 * rol que nadie puede revisar después.
 */
@Injectable()
export class AdminBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auditLog: AuditLogService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Nunca hace caer el arranque. Que el panel quede sin administrador es un
    // problema; que la API entera no levante por eso es peor.
    try {
      await this.sync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`No se pudo aplicar ADMIN_EMAILS: ${message}`);
    }
  }

  /** Las direcciones configuradas, en su forma canónica y sin repetidos. */
  configuredEmails(): string[] {
    const crudo = this.config.get<string>("ADMIN_EMAILS") ?? "";
    const emails = crudo
      .split(/[,\s;]+/)
      .map((valor) => normalizeEmail(valor))
      .filter((valor): valor is string => Boolean(valor));
    return [...new Set(emails)];
  }

  /**
   * Aplica la configuración. Devuelve a quiénes promovió (vacío en el caso
   * normal: ya eran admin desde el arranque anterior).
   */
  async sync(): Promise<string[]> {
    const emails = this.configuredEmails();
    if (emails.length === 0) return [];

    const candidatas = await this.prisma.user.findMany({
      where: {
        email: { in: emails },
        role: { not: UserRole.ADMIN },
        status: { in: [UserStatus.ACTIVE, UserStatus.PENDING_VERIFICATION] },
      },
      select: { id: true, email: true },
    });

    if (candidatas.length === 0) {
      // Vale la pena decirlo: una variable escrita con un mail que no existe
      // se ve exactamente igual que una que ya se aplicó, y la diferencia
      // entre las dos son varias horas de buscar por qué el panel da 403.
      const existentes = await this.prisma.user.count({
        where: { email: { in: emails }, role: UserRole.ADMIN },
      });
      if (existentes === 0) {
        this.logger.warn(
          `ADMIN_EMAILS nombra ${emails.length} dirección(es) que no ` +
            "corresponden a ninguna cuenta activa. La cuenta tiene que " +
            "registrarse primero; en el próximo arranque queda promovida.",
        );
      }
      return [];
    }

    for (const cuenta of candidatas) {
      await this.prisma.user.update({
        where: { id: cuenta.id },
        data: { role: UserRole.ADMIN },
      });
      await this.auditLog.create({
        targetUserId: cuenta.id,
        action: "admin.user.role.bootstrap",
        entityType: "User",
        entityId: cuenta.id,
        metadata: { role: UserRole.ADMIN, source: "ADMIN_EMAILS" },
      });
      this.logger.log(`${cuenta.email} quedó como ADMIN (ADMIN_EMAILS).`);
    }

    return candidatas.map((c) => c.email);
  }
}
