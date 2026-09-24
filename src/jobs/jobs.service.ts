import { Injectable, Logger } from "@nestjs/common";
import { BookingStatus, DamageClaimStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PaymentsService } from "../payments/payments.service";
import { ClaimsService } from "../claims/claims.service";
import { RetentionService } from "../retention/retention.service";

export interface JobRunResult {
  claimsExpired: number;
  bookingsSettled: number;
  settlementsFailed: number;
  payoutsRetried: number;
  paymentsReconciled: number;
  refundsRetried: number;
  retention: unknown;
}

/**
 * LO QUE TIENE QUE PASAR AUNQUE NADIE ENTRE A LA APP.
 *
 * Tres cosas que dependen del paso del tiempo y no de que alguien haga clic:
 *
 *   · las ventanas de inspección que se cerraron sin reclamo: hay que soltar
 *     el depósito y pagarle al dueño;
 *   · los reclamos que quien alquiló dejó sin contestar: pasan a un admin;
 *   · las fotos de documentos cuya conservación ya venció.
 *
 * ── Por qué no alcanza con esto solo ────────────────────────────────────────
 * En el plan gratuito de Vercel un cron corre UNA VEZ POR DÍA, así que una
 * ventana que vence a las 10 de la mañana se puede liquidar recién a la
 * madrugada siguiente. Por eso la liquidación también se puede pedir a mano
 * (POST /bookings/:id/settle, que puede llamar cualquiera de las dos partes) y
 * es idempotente: si el cron y una persona la piden a la vez, se hace una sola
 * vez.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly claims: ClaimsService,
    private readonly retention: RetentionService,
  ) {}

  async runDaily(now: Date = new Date()): Promise<JobRunResult> {
    const claimsExpired = await this.claims.expireUnanswered(now);

    // Reservas para liquidar: las que cerraron la inspección sin reclamo, y
    // las que tienen un reclamo ya resuelto pero cuya liquidación no llegó a
    // completarse (el procesador falló, el proceso se cortó).
    const pendientes = await this.prisma.booking.findMany({
      where: {
        settledAt: null,
        OR: [
          {
            status: BookingStatus.INSPECTION,
            inspectionEndsAt: { lt: now },
            damageClaim: { is: null },
          },
          {
            status: BookingStatus.DISPUTED,
            damageClaim: {
              status: {
                in: [
                  DamageClaimStatus.ACCEPTED,
                  DamageClaimStatus.RESOLVED,
                  DamageClaimStatus.WITHDRAWN,
                ],
              },
            },
          },
        ],
      },
      select: { id: true },
      take: 200,
    });

    let bookingsSettled = 0;
    let settlementsFailed = 0;
    for (const booking of pendientes) {
      try {
        const r = await this.payments.settleBooking(booking.id, null, { now });
        if (r.settled) bookingsSettled += 1;
      } catch (error) {
        // Una reserva que no se puede liquidar no puede frenar a las demás.
        settlementsFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`no se pudo liquidar ${booking.id}: ${message}`);
      }
    }

    const payoutsRetried = await this.payments.retryPendingPayouts();

    // Los cobros que quedaron sin resolver se le preguntan a Mercado Pago: un
    // pago aprobado mientras un aviso se perdía, o una reserva de fondos que
    // venció sola, se ven igual aunque el aviso no llegue nunca.
    const paymentsReconciled =
      await this.payments.reconcilePendingPayments(now);
    // Y las cancelaciones cuya devolución falló (el dueño sin saldo en su
    // cuenta) se vuelven a intentar hasta que salgan.
    const refundsRetried = await this.payments.retryFailedCancellations(now);

    const retention = await this.retention.purgeExpired(now);

    const resumen = {
      claimsExpired,
      bookingsSettled,
      settlementsFailed,
      payoutsRetried,
      paymentsReconciled,
      refundsRetried,
      retention,
    };
    this.logger.log(`corrida diaria: ${JSON.stringify(resumen)}`);
    return resumen;
  }
}
