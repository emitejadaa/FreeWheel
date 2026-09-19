import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Booking,
  BookingStatus,
  DamageClaimStatus,
  PaymentRecord,
  PaymentRecordKind,
  PaymentRecordStatus,
  PaymentStatus,
  Prisma,
  StripeAccountStatus,
  User,
} from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { USER_CONTACT_SELECT } from "../common/constants/prisma-select";
import { EmailService } from "../email/email.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { PrismaService } from "../prisma/prisma.service";
import { estadoDeLaRevision } from "../claims/claim-window";
import { PAYMENT_PROVIDER } from "./providers/payment-provider.interface";
import type {
  PaymentIntentResult,
  PaymentProvider,
  PaymentRecordKindLike,
  SavedCard,
} from "./providers/payment-provider.interface";

/** Estados en los que la plata efectivamente entró. */
const PAID_RECORD_STATUSES: PaymentRecordStatus[] = [
  PaymentRecordStatus.PAID,
  PaymentRecordStatus.CAPTURED,
];

/**
 * Estados de un intent que NO se pueden reutilizar: hay que crear uno nuevo.
 *
 * Un intent fallado o cancelado no se puede volver a confirmar del lado de
 * Stripe, así que devolverle al front su client secret sería mandarlo a
 * intentar contra algo muerto.
 */
const UNUSABLE_RECORD_STATUSES: PaymentRecordStatus[] = [
  PaymentRecordStatus.FAILED,
  PaymentRecordStatus.CANCELLED,
];

/**
 * QUIÉN PIDIÓ ESTO Y DESDE DÓNDE.
 *
 * Viaja con cada pedido que mueve plata y queda guardado en el registro. No es
 * telemetría: es lo que permite contestar un desconocimiento de cobro ("este
 * pago salió de esta IP, con esta tarjeta, a esta hora") y ver el patrón de
 * alguien que prueba tarjetas robadas desde una misma conexión.
 */
export interface PaymentContext {
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {}

  // ── Creación de intents (la pide quien alquila) ────────────────────────

  createSenaIntent(renterId: string, bookingId: string, ctx: PaymentContext) {
    return this.createChargeIntent(renterId, bookingId, "SENA", ctx);
  }

  async createBalanceIntent(
    renterId: string,
    bookingId: string,
    ctx: PaymentContext,
  ) {
    // El saldo exige que la seña ya esté COBRADA, y se controla contra los
    // registros y no contra `booking.paymentStatus`.
    //
    // La diferencia importa: `paymentStatus` es un resumen que también se
    // escribe desde otros lados (una devolución lo deja en REFUNDED, un fallo
    // en FAILED), así que mirarlo ahí dejaba pasar el saldo de una reserva
    // cuya seña había fallado. Los registros dicen si esa plata entró.
    const senaPagada = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.SENA,
        status: { in: PAID_RECORD_STATUSES },
      },
      select: { id: true },
    });
    if (!senaPagada) {
      throw new BadRequestException({
        statusCode: 400,
        code: "SENA_NOT_PAID",
        message: "Hay que pagar la seña antes que el saldo",
      });
    }
    return this.createChargeIntent(renterId, bookingId, "BALANCE", ctx);
  }

  createDepositHold(renterId: string, bookingId: string, ctx: PaymentContext) {
    return this.createChargeIntent(renterId, bookingId, "DEPOSIT_HOLD", ctx);
  }

  /**
   * LAS TARJETAS QUE ESTA PERSONA YA NO TIENE QUE VOLVER A ESCRIBIR.
   *
   * ── Qué problema resuelve ─────────────────────────────────────────────────
   * El alquiler se paga en tres tramos —seña, saldo, depósito— y cada uno es
   * un cobro aparte contra el procesador. Sin esto, quien alquila escribe el
   * mismo número de tarjeta TRES VECES en la misma pantalla, con el mismo
   * vencimiento y el mismo código, en el mismo minuto. No es una molestia
   * menor: cada vez que se escribe es una vez más que se puede tipear mal, y
   * la tercera —el depósito— es la que más se abandona, que justo es la que
   * deja el auto entregado sin garantía.
   *
   * ── Por qué es una ruta aparte y no un campo del estado ───────────────────
   * Porque la pantalla de pago pregunta el estado de la reserva hasta catorce
   * veces seguidas mientras espera el aviso del procesador (es la única forma
   * de saber que el cobro entró). Colgar las tarjetas de ahí serían catorce
   * llamadas al procesador por cobro, para un dato que no cambia durante la
   * espera. Así es una sola, al abrir la pantalla.
   *
   * ── Por qué no crea nada ──────────────────────────────────────────────────
   * Quien todavía no pagó nunca no tiene cliente en el procesador, y esto es
   * una consulta: crear uno acá le daría un cliente a cada persona que abre la
   * pantalla de pago y se va sin pagar. Sin cliente no hay tarjetas guardadas,
   * que es exactamente la respuesta correcta.
   */
  async listSavedCards(userId: string): Promise<{ cards: SavedCard[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    assertFound(user, "User not found");
    // Un identificador de otro proveedor (una `cus_mock_…` que quedó de cuando
    // este deploy corría en simulación) no se le manda al procesador: contesta
    // "No such customer" y rompe la pantalla por una comodidad.
    if (!this.esDelProveedorActual(user.stripeCustomerId)) {
      return { cards: [] };
    }
    const cards = await this.provider.listSavedCards(
      user.stripeCustomerId as string,
    );
    return { cards };
  }

  private async createChargeIntent(
    renterId: string,
    bookingId: string,
    kind: PaymentRecordKindLike,
    ctx: PaymentContext,
  ) {
    const booking = await this.findBookingWithUsers(bookingId);
    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can pay for this booking");
    }
    if (booking.status !== BookingStatus.ACCEPTED) {
      throw new BadRequestException(
        "Payments can only be made on accepted bookings",
      );
    }

    const amountMinor = this.amountForKind(booking, kind);
    const currency = booking.currency;

    // Idempotente: se reutiliza un intent vivo del mismo tramo SI Y SOLO SI es
    // por el mismo importe y la misma moneda.
    //
    // Esa condición no estaba y era un agujero silencioso: si el precio de la
    // reserva cambiaba entre que se creaba el intent y que se pagaba, el front
    // recibía el intent viejo y se cobraba el importe anterior. El control de
    // precio del servidor no servía de nada porque el cobro ya no pasaba por
    // él.
    const existing = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: kind as PaymentRecordKind,
        status: { notIn: UNUSABLE_RECORD_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      existing?.stripePaymentIntentId &&
      existing.amountMinor === amountMinor &&
      existing.currency === currency
    ) {
      // El client secret NO se guarda en la base y se vuelve a pedir acá.
      //
      // Es una credencial: con ella se confirma el pago de ese intent. Tenerla
      // escrita en una columna significaba que cualquier volcado de la base
      // —un backup, un log de consulta, una captura de pantalla del panel—
      // repartía la capacidad de operar sobre cobros ajenos. Pedirla de nuevo
      // cuesta una llamada y la deja existiendo solo mientras dura la
      // respuesta.
      const vigente = await this.safeRetrieve(existing.stripePaymentIntentId);
      return {
        bookingId,
        kind,
        paymentIntentId: existing.stripePaymentIntentId,
        clientSecret: vigente?.clientSecret ?? null,
        amountMinor: existing.amountMinor ?? amountMinor,
        currency,
        status: existing.status,
        reused: true,
      };
    }

    const customerId = await this.ensureRenterCustomer(booking.renter);
    const input = {
      bookingId,
      kind,
      amountMinor,
      currency,
      customerId,
      transferGroup: booking.transferGroup,
      metadata: { renterId: booking.renterId, ownerId: booking.ownerId },
      // La clave de idempotencia lleva el importe adentro: sin él, un intent
      // creado por $100 y otro por $120 compartían clave y Stripe devolvía el
      // primero, cobrando el precio viejo.
      idempotencyKey: `booking_${bookingId}_${kind.toLowerCase()}_${amountMinor}`,
      /*
        QUE LA TARJETA QUEDE GUARDADA, para que el tramo siguiente no la pida
        de nuevo. Ver `listSavedCards` acá arriba para el porqué.

        En el depósito no: es una retención con captura manual, puede terminar
        soltada sin cobrar nada, y una tarjeta solo queda guardada cuando el
        cobro se concreta. Pedirlo ahí daría una tarjeta guardada a veces sí y
        a veces no. La guarda la seña, que es el primer tramo y siempre entra.
      */
      saveCard: kind !== "DEPOSIT_HOLD",
    };

    const intent =
      kind === "DEPOSIT_HOLD"
        ? await this.provider.createDepositHold(input)
        : await this.provider.createPaymentIntent(input);

    /*
      UPSERT Y NO CREATE, Y ACÁ HAY UN ERROR QUE COSTÓ CARO.

      ── Qué pasaba ─────────────────────────────────────────────────────────
      Una tarjeta rechazada dejaba el registro en FAILED, que este código trata
      como inservible: no lo reutiliza y sale a pedir otro intent. Pero la clave
      de idempotencia es la misma —la reserva, el tramo y el importe no
      cambiaron—, así que Stripe hacía lo correcto y devolvía EL MISMO intent de
      antes. Y ahí esto intentaba INSERTAR un segundo registro con el mismo
      `stripePaymentIntentId`, que es una columna única.

      Resultado: violación de unicidad, un error de Prisma que nadie atrapaba, y
      un 500 mudo "Internal server error" en la pantalla de pago. O sea que
      después de UN rechazo de tarjeta, esa reserva no se podía pagar nunca más:
      cada intento moría con un error que no hablaba de la tarjeta ni del cobro.

      ── Por qué upsert es la respuesta y no una clave distinta ─────────────
      Porque reintentar el MISMO intent es lo que Stripe espera: un intent que
      falló vuelve a `requires_payment_method` y se puede confirmar de nuevo con
      otra tarjeta. Inventarle una clave nueva a cada reintento crearía un
      intent nuevo por cada tarjeta rechazada, que es basura en la cuenta y no
      arregla nada.

      Así que si Stripe devuelve el intent de antes, se reusa su fila y se la
      vuelve a poner a la espera. El historial no se pierde: lo que pasó con ese
      cobro —incluido el rechazo— vive en PaymentEvent, que es append-only y
      para eso está.
    */
    const datos = {
      bookingId,
      userId: booking.renterId,
      kind: kind as PaymentRecordKind,
      status: PaymentRecordStatus.REQUIRES_ACTION,
      provider: this.provider.name,
      providerId: intent.id,
      stripePaymentIntentId: intent.id,
      amount: amountMinor / 100,
      amountMinor,
      currency,
      initiatedIp: ctx.ip ?? null,
      initiatedUserAgent: ctx.userAgent?.slice(0, 500) ?? null,
      // `metadata` ya no lleva el client secret (ver arriba). Lleva las dos
      // partes de la reserva, que es lo que hace falta para reconstruir un
      // cobro sin tener que ir a buscar la reserva.
      metadata: {
        renterId: booking.renterId,
        ownerId: booking.ownerId,
      } as Prisma.InputJsonValue,
    };
    const record = await this.prisma.paymentRecord.upsert({
      where: { stripePaymentIntentId: intent.id },
      create: datos,
      update: {
        status: PaymentRecordStatus.REQUIRES_ACTION,
        amount: datos.amount,
        amountMinor: datos.amountMinor,
        currency: datos.currency,
        initiatedIp: datos.initiatedIp,
        initiatedUserAgent: datos.initiatedUserAgent,
      },
    });

    if (kind === "DEPOSIT_HOLD") {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { depositPaymentIntentId: intent.id },
      });
    }

    await this.recordEvent({
      record,
      bookingId,
      actorId: renterId,
      source: "api",
      type: `${kind.toLowerCase()}.intent.created`,
      status: PaymentRecordStatus.REQUIRES_ACTION,
      amountMinor,
      currency,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    await this.auditLog.create({
      actorId: renterId,
      targetUserId: booking.ownerId,
      action: `payment.${kind.toLowerCase()}.intent_created`,
      entityType: "Booking",
      entityId: bookingId,
      metadata: { paymentIntentId: intent.id, amountMinor },
    });

    return {
      bookingId,
      kind,
      paymentIntentId: intent.id,
      clientSecret: intent.clientSecret,
      amountMinor,
      currency,
      status: record.status,
      reused: false,
    };
  }

  private amountForKind(booking: Booking, kind: PaymentRecordKindLike): number {
    const map: Record<PaymentRecordKindLike, number | null> = {
      SENA: booking.senaAmountSnapshot,
      BALANCE: booking.balanceAmountSnapshot,
      DEPOSIT_HOLD: booking.depositSnapshot,
    };
    const value = map[kind];
    if (value == null) {
      throw new BadRequestException(
        "Booking is missing pricing snapshots; accept it first",
      );
    }
    const minor = Math.round(value * 100);
    if (!Number.isFinite(minor) || minor <= 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_AMOUNT",
        message: "El importe de este cobro no es válido",
      });
    }
    return minor;
  }

  // ── Simulación offline (solo con el provider mock, que es el de los tests) ──

  /**
   * Completa el pago de una reserva sin pasar por el procesador.
   *
   * Existe SOLO para los tests automatizados, que corren con
   * PAYMENTS_PROVIDER=mock y no tienen quién les mande un webhook firmado. Con
   * el provider Stripe está deshabilitado (403), y la demo usa Stripe: ahí el
   * pago lo confirma Stripe y el aviso llega por webhook, como en producción.
   */
  async simulatePaymentSuccess(
    renterId: string,
    bookingId: string,
    kind: PaymentRecordKindLike | undefined,
    ctx: PaymentContext,
  ) {
    this.assertMockProvider();
    const kinds: PaymentRecordKindLike[] = kind
      ? [kind]
      : ["SENA", "BALANCE", "DEPOSIT_HOLD"];

    for (const current of kinds) {
      // El intent de saldo exige que la seña ya esté paga, así que el orden del
      // array importa: cada vuelta ve el estado que dejó la anterior.
      const intent =
        current === "BALANCE"
          ? await this.createBalanceIntent(renterId, bookingId, ctx)
          : await this.createChargeIntent(renterId, bookingId, current, ctx);

      if (current === "DEPOSIT_HOLD") {
        await this.onHoldAuthorized(intent.paymentIntentId);
      } else {
        await this.onIntentSucceeded(intent.paymentIntentId);
      }
    }

    return this.getStatus(renterId, bookingId);
  }

  /** Contracara de simulatePaymentSuccess: deja el cobro pendiente en FAILED. */
  async simulatePaymentFailure(
    renterId: string,
    bookingId: string,
    kind: PaymentRecordKindLike = "SENA",
  ) {
    this.assertMockProvider();
    const booking = await this.findBooking(bookingId);
    if (booking.renterId !== renterId) {
      throw new ForbiddenException("Only the renter can pay for this booking");
    }

    const record = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: kind as PaymentRecordKind,
        status: { notIn: UNUSABLE_RECORD_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });

    if (record?.stripePaymentIntentId) {
      await this.onIntentFailed(record.stripePaymentIntentId);
    } else {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: { paymentStatus: PaymentStatus.FAILED },
      });
    }

    return this.getStatus(renterId, bookingId);
  }

  private assertMockProvider() {
    if (this.provider.name !== "mock") {
      throw new ForbiddenException({
        statusCode: 403,
        code: "SIMULATION_DISABLED",
        message:
          "La simulación de pagos solo existe para los tests automatizados " +
          "(PAYMENTS_PROVIDER=mock). Acá los pagos los confirma Stripe.",
      });
    }
  }

  // ── Estado ─────────────────────────────────────────────────────────────

  async getStatus(userId: string, bookingId: string) {
    const booking = await this.findBookingForParticipant(userId, bookingId);

    /*
      ACÁ SE SUELTA EL DEPÓSITO CUYA VENTANA VENCIÓ, Y NO ES UN CAPRICHO.

      Este backend no tiene un programador de tareas, así que nadie se despierta
      a las 48 horas a soltar la retención. Se hace cuando alguien pregunta por
      esta reserva, que en la práctica es quien alquiló mirando si le volvió la
      plata: el momento exacto en que importa.

      No cuesta nada en el camino caliente: solo entra si la reserva está
      devuelta, la ventana venció, no hay reclamo abierto y todavía queda una
      retención viva. En cualquier otro caso son dos consultas y nada más. Y si
      falla, no se lleva puesta la consulta del estado: el peor caso es que la
      retención se caiga sola cuando expire en Stripe, a los 7 días.
    */
    if (booking.status === BookingStatus.COMPLETED) {
      await this.liberarDepositoSiCorresponde(userId, bookingId).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `No se pudo soltar el depósito vencido de ${bookingId}: ${message}`,
          );
        },
      );
    }

    const records = await this.prisma.paymentRecord.findMany({
      where: { bookingId },
      orderBy: { createdAt: "asc" },
    });
    return {
      bookingId,
      paymentStatus: booking.paymentStatus,
      currency: booking.currency,
      total: booking.totalPriceSnapshot,
      sena: booking.senaAmountSnapshot,
      balance: booking.balanceAmountSnapshot,
      deposit: booking.depositSnapshot,
      commission: booking.platformFeeSnapshot,
      insurance: booking.insuranceSnapshot,
      ownerPayout: booking.ownerPayoutSnapshot,
      ownerTransferId: booking.ownerTransferId,
      depositCapturedAmount: booking.depositCapturedAmount,
      paidAt: booking.paidAt,
      refundedAt: booking.refundedAt,
      records: records.map((record) => publicRecord(record)),
    };
  }

  // ── Webhook ────────────────────────────────────────────────────────────

  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    let event;
    try {
      event = this.provider.constructWebhookEvent(rawBody, signature);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`webhook rechazado: ${message}`);
      throw new BadRequestException("Invalid Stripe webhook signature");
    }

    // UN EVENTO DEL MODO REAL LLEGANDO A UN DEPLOY DE PRUEBA SE DESCARTA.
    //
    // Si esto pasa, algo está cruzado: las claves, o un webhook de la cuenta
    // real apuntado a este proyecto. Procesarlo movería plata de verdad sobre
    // reservas que son de mentira. Se contesta 200 para que Stripe no reintente
    // eternamente, pero no se toca nada.
    if (event.livemode && !this.enModoReal()) {
      this.logger.error(
        `evento livemode ${event.id} (${event.type}) recibido por un deploy ` +
          "en modo de prueba: descartado. Revisar a qué proyecto apunta el " +
          "webhook de la cuenta de Stripe real.",
      );
      return { received: true, ignored: "livemode_mismatch" as const };
    }

    // La unicidad de `eventId` es lo que hace el descarte de duplicados, y se
    // apoya en la base y no en un `findUnique` previo: dos entregas del mismo
    // evento llegando a la vez pasaban las dos por el chequeo y se procesaban
    // dos veces (Stripe reintenta, y reintenta en paralelo).
    try {
      await this.prisma.stripeEvent.create({
        data: {
          eventId: event.id,
          type: event.type,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Ya procesado, o todavía procesándose por otra entrega: en los dos
        // casos se descarta. El que lo está procesando va a terminar, y si no
        // termina Stripe vuelve a mandarlo (la fila queda sin processedAt, así
        // que se ve cuál quedó a medias).
        return { received: true, duplicate: true as const, type: event.type };
      }
      throw error;
    }

    await this.dispatchEvent(event.id, event.type, event.data.object);

    await this.prisma.stripeEvent.update({
      where: { eventId: event.id },
      data: { processedAt: new Date() },
    });

    return { received: true, duplicate: false as const, type: event.type };
  }

  private async dispatchEvent(
    eventId: string,
    type: string,
    object: Record<string, unknown>,
  ): Promise<void> {
    const id = object.id as string | undefined;
    if (!id) return;

    switch (type) {
      case "payment_intent.succeeded":
        await this.onIntentSucceeded(id, eventId);
        break;
      case "payment_intent.amount_capturable_updated":
        await this.onHoldAuthorized(id, eventId);
        break;
      case "payment_intent.processing":
        await this.onIntentProcessing(id, eventId);
        break;
      case "payment_intent.payment_failed":
        await this.onIntentFailed(id, eventId);
        break;
      case "payment_intent.canceled":
        await this.onIntentCanceled(id, eventId);
        break;
      case "charge.refunded":
        await this.onChargeRefunded(object, eventId);
        break;
      case "charge.dispute.created":
      case "charge.dispute.funds_withdrawn":
        await this.onDisputeOpened(object, eventId);
        break;
      case "account.updated":
        await this.onConnectedAccountUpdated(object, eventId);
        break;
      default:
        // Un evento que no nos interesa no es un error: Stripe manda muchos y
        // suscribirse de más es más seguro que de menos. Queda anotado y ya.
        this.logger.debug(`evento ${type} recibido y no aplicado`);
    }
  }

  /**
   * Un cobro se concretó.
   *
   * Antes de tocar nada se le pregunta al procesador por el intent completo:
   * el webhook trae el id del cargo pero no el cargo, así que la tarjeta y la
   * evaluación de riesgo —lo único que después permite responder un
   * desconocimiento de cobro— solo se consiguen preguntando.
   */
  private async onIntentSucceeded(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record?.bookingId) return;
    const bookingId = record.bookingId;
    const detalle = await this.safeRetrieve(piId);

    // El importe que Stripe dice haber cobrado contra el que esta reserva
    // esperaba. Un desajuste es una señal de manipulación o de un intent que
    // no es de esta reserva; no se revierte solo —la plata ya entró— pero
    // queda gritado en el log y guardado en el registro.
    if (
      detalle?.amountReceivedMinor != null &&
      record.amountMinor != null &&
      detalle.amountReceivedMinor !== record.amountMinor
    ) {
      this.logger.error(
        `el cobro ${piId} entró por ${detalle.amountReceivedMinor} y la ` +
          `reserva ${bookingId} esperaba ${record.amountMinor}`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.paymentRecord.update({
        where: { id: record.id },
        data: {
          status: PaymentRecordStatus.CAPTURED,
          stripeChargeId: detalle?.chargeId ?? undefined,
          paidAt: new Date(),
          capturedAt: new Date(),
          failureCode: null,
          failureMessage: null,
          ...cardColumns(detalle),
        },
      });

      if (record.kind === PaymentRecordKind.SENA) {
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { paymentStatus: true },
        });
        if (booking?.paymentStatus === PaymentStatus.PENDING) {
          await tx.booking.update({
            where: { id: bookingId },
            data: {
              paymentStatus: PaymentStatus.DEPOSIT_PAID,
              paidAt: new Date(),
            },
          });
        }
      } else if (record.kind === PaymentRecordKind.BALANCE) {
        const charged = await tx.paymentRecord.findMany({
          where: {
            bookingId,
            kind: { in: [PaymentRecordKind.SENA, PaymentRecordKind.BALANCE] },
            status: { in: PAID_RECORD_STATUSES },
          },
          select: { kind: true },
        });
        const kinds = new Set(charged.map((r) => r.kind));
        if (
          kinds.has(PaymentRecordKind.SENA) &&
          kinds.has(PaymentRecordKind.BALANCE)
        ) {
          await tx.booking.update({
            where: { id: bookingId },
            data: {
              paymentStatus: PaymentStatus.FULLY_PAID,
              paidAt: new Date(),
            },
          });
        }
      }
      return actualizado;
    });

    await this.recordEvent({
      record: updated,
      bookingId,
      source: "webhook",
      type: "intent.succeeded",
      status: PaymentRecordStatus.CAPTURED,
      amountMinor: detalle?.amountReceivedMinor ?? record.amountMinor,
      currency: record.currency,
      providerEventId: eventId,
      payload: detalle
        ? { status: detalle.status, chargeId: detalle.chargeId }
        : null,
    });

    await this.auditLog.create({
      action: "payment.intent.succeeded",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { paymentIntentId: piId, kind: record.kind },
    });

    await this.avisarDelPago(bookingId, record.kind, record.amount);
  }

  /** Cómo se llama cada cobro para una persona, no para el código. */
  private static readonly CONCEPTO: Record<string, string> = {
    SENA: "Seña",
    BALANCE: "Saldo",
    DEPOSIT_HOLD: "Depósito en garantía",
    DEPOSIT_CAPTURE: "Cobro del depósito en garantía",
  };

  /**
   * Comprobante al inquilino y aviso al dueño, cada vez que un cobro se concreta.
   *
   * Va acá, en onIntentSucceeded, porque es el ÚNICO lugar por donde pasan los
   * dos caminos: el webhook de Stripe y el pago simulado de los tests. Ponerlo
   * en cada uno serían dos lugares para olvidarse de uno.
   *
   * Nunca hace fallar el pago: si el mail no sale, queda en el log. Un cobro que
   * se revierte porque no salió un mail sería mucho peor que un mail perdido.
   */
  private async avisarDelPago(
    bookingId: string,
    kind: PaymentRecordKind | null,
    amount: number | null,
  ): Promise<void> {
    // Sin concepto o sin importe no hay comprobante que tenga sentido mandar.
    if (!kind || amount == null) return;
    try {
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          owner: { select: USER_CONTACT_SELECT },
          renter: { select: USER_CONTACT_SELECT },
          vehicle: { select: { brand: true, model: true, year: true } },
        },
      });
      if (!booking) return;

      const concepto = PaymentsService.CONCEPTO[kind] ?? "Pago";
      const vehicleLabel =
        [booking.vehicle?.brand, booking.vehicle?.model, booking.vehicle?.year]
          .filter(Boolean)
          .join(" ") || "el vehículo";
      const nombre = (persona?: {
        displayName?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      }) =>
        persona?.displayName ??
        [persona?.firstName, persona?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();

      // Lo pagado hasta ahora, para que el comprobante ubique el pago dentro del
      // total en vez de mostrar un número suelto.
      const pagados = await this.prisma.paymentRecord.aggregate({
        where: {
          bookingId,
          kind: { in: [PaymentRecordKind.SENA, PaymentRecordKind.BALANCE] },
          status: { in: PAID_RECORD_STATUSES },
        },
        _sum: { amount: true },
      });

      if (booking.renter?.email) {
        await this.email.sendPaymentReceipt(booking.renter.email, {
          renterName: nombre(booking.renter),
          concepto,
          amount,
          currency: booking.currency,
          vehicleLabel,
          startDate: booking.startDate,
          endDate: booking.endDate,
          totalPaid: pagados._sum.amount ?? undefined,
          bookingId: booking.id,
        });
      }

      // El depósito en garantía es una retención, no plata que cobre el dueño:
      // avisarle que "recibió un pago" por eso sería confundirlo.
      if (booking.owner?.email && kind !== PaymentRecordKind.DEPOSIT_HOLD) {
        await this.email.sendPaymentReceivedToOwner(booking.owner.email, {
          ownerName: nombre(booking.owner),
          renterName: nombre(booking.renter) || "El inquilino",
          concepto,
          amount,
          currency: booking.currency,
          vehicleLabel,
          startDate: booking.startDate,
          endDate: booking.endDate,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `No se pudo avisar del pago de ${bookingId}: ${message}`,
      );
    }
  }

  /** La retención del depósito quedó autorizada: la plata está bloqueada. */
  private async onHoldAuthorized(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;
    const detalle = await this.safeRetrieve(piId);

    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status: PaymentRecordStatus.AUTHORIZED,
        stripeChargeId: detalle?.chargeId ?? undefined,
        ...cardColumns(detalle),
      },
    });

    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: "hold.authorized",
      status: PaymentRecordStatus.AUTHORIZED,
      amountMinor: detalle?.amountCapturableMinor ?? record.amountMinor,
      currency: record.currency,
      providerEventId: eventId,
    });
  }

  /**
   * El medio de pago se está procesando: ni éxito ni fracaso.
   *
   * Existe porque sin este estado un pago en curso se veía igual que uno que
   * nunca se intentó, y el front le mostraba a alguien que ya había pagado el
   * botón de pagar otra vez.
   */
  private async onIntentProcessing(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;
    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: { status: PaymentRecordStatus.PROCESSING },
    });
    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: "intent.processing",
      status: PaymentRecordStatus.PROCESSING,
      providerEventId: eventId,
    });
  }

  private async onIntentFailed(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record?.bookingId) return;
    const bookingId = record.bookingId;
    const detalle = await this.safeRetrieve(piId);
    const isCharge =
      record.kind === PaymentRecordKind.SENA ||
      record.kind === PaymentRecordKind.BALANCE;

    const updated = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.paymentRecord.update({
        where: { id: record.id },
        data: {
          status: PaymentRecordStatus.FAILED,
          failureCode: detalle?.failure?.code ?? null,
          failureMessage: detalle?.failure?.message ?? null,
          ...cardColumns(detalle),
        },
      });
      if (isCharge) {
        await tx.booking.update({
          where: { id: bookingId },
          data: { paymentStatus: PaymentStatus.FAILED },
        });
      }
      return actualizado;
    });

    await this.recordEvent({
      record: updated,
      bookingId,
      source: "webhook",
      type: "intent.failed",
      status: PaymentRecordStatus.FAILED,
      amountMinor: record.amountMinor,
      currency: record.currency,
      providerEventId: eventId,
      payload: detalle?.failure ? { ...detalle.failure } : null,
    });
  }

  private async onIntentCanceled(piId: string, eventId?: string) {
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;
    // Cancelar una retención ES soltarla: para quien alquiló, su plata se
    // desbloqueó. Distinguirlo de un intent de cobro cancelado importa porque
    // son dos cosas distintas para quien lee el historial.
    const esRetencion = record.kind === PaymentRecordKind.DEPOSIT_HOLD;
    const status = esRetencion
      ? PaymentRecordStatus.RELEASED
      : PaymentRecordStatus.CANCELLED;

    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status,
        ...(esRetencion ? { releasedAt: new Date() } : {}),
      },
    });
    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: esRetencion ? "hold.released" : "intent.canceled",
      status,
      providerEventId: eventId,
    });
  }

  /**
   * Una devolución se concretó del lado del procesador.
   *
   * Llega también cuando la devolución la inició alguien desde el panel de
   * Stripe y no desde acá, que es justamente el caso que antes dejaba la base
   * diciendo "cobrado" sobre plata que ya se había devuelto.
   */
  private async onChargeRefunded(
    object: Record<string, unknown>,
    eventId?: string,
  ) {
    const piId = object.payment_intent as string | undefined;
    if (!piId) return;
    const record = await this.prisma.paymentRecord.findUnique({
      where: { stripePaymentIntentId: piId },
    });
    if (!record) return;

    const refundedMinor = Number(object.amount_refunded ?? 0);
    const totalMinor = Number(object.amount ?? record.amountMinor ?? 0);
    const completa = refundedMinor >= totalMinor && totalMinor > 0;

    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status: completa
          ? PaymentRecordStatus.REFUNDED
          : PaymentRecordStatus.PARTIALLY_REFUNDED,
        refundedAmountMinor: refundedMinor,
        refundedAt: new Date(),
      },
    });

    if (completa && record.bookingId) {
      await this.prisma.booking.update({
        where: { id: record.bookingId },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
          refundedAt: new Date(),
        },
      });
    }

    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: completa ? "refund.completed" : "refund.partial",
      status: updated.status,
      amountMinor: refundedMinor,
      currency: record.currency,
      providerEventId: eventId,
    });
  }

  /**
   * EL TITULAR DE LA TARJETA DESCONOCIÓ EL COBRO.
   *
   * Es el evento más caro de todos: la plata se va, y se va del saldo de la
   * plataforma. Lo importante acá es que quede MARCADO antes de que se le
   * transfiera nada al dueño del auto — si el pago se revierte después de
   * haberle pagado, la pérdida la come la plataforma entera.
   *
   * Por eso `settleOnReturn` se niega a liquidar una reserva con una disputa
   * abierta.
   */
  private async onDisputeOpened(
    object: Record<string, unknown>,
    eventId?: string,
  ) {
    const chargeId = object.charge as string | undefined;
    const piId = object.payment_intent as string | undefined;
    const record = piId
      ? await this.prisma.paymentRecord.findUnique({
          where: { stripePaymentIntentId: piId },
        })
      : chargeId
        ? await this.prisma.paymentRecord.findFirst({
            where: { stripeChargeId: chargeId },
          })
        : null;
    if (!record) return;

    const updated = await this.prisma.paymentRecord.update({
      where: { id: record.id },
      data: {
        status: PaymentRecordStatus.DISPUTED,
        disputedAt: new Date(),
      },
    });

    if (record.bookingId) {
      await this.prisma.booking.update({
        where: { id: record.bookingId },
        data: { paymentStatus: PaymentStatus.DISPUTED },
      });
    }

    await this.recordEvent({
      record: updated,
      bookingId: record.bookingId,
      source: "webhook",
      type: "dispute.opened",
      status: PaymentRecordStatus.DISPUTED,
      amountMinor: Number(object.amount ?? record.amountMinor ?? 0),
      currency: record.currency,
      providerEventId: eventId,
      payload: { reason: object.reason ?? null, status: object.status ?? null },
    });

    this.logger.error(
      `DISPUTA abierta sobre ${record.stripePaymentIntentId} ` +
        `(reserva ${record.bookingId}). La liquidación al dueño queda frenada.`,
    );

    await this.auditLog.create({
      targetUserId: record.userId ?? undefined,
      action: "payment.dispute.opened",
      entityType: "Booking",
      entityId: record.bookingId ?? "",
      metadata: {
        paymentIntentId: record.stripePaymentIntentId,
        reason: object.reason ?? null,
      },
    });
  }

  /**
   * La cuenta conectada de un dueño cambió de estado.
   *
   * Sin esto, `stripeAccountStatus` se quedaba en PENDING para siempre: se
   * escribía al empezar el alta y nadie volvía a mirarlo. El resultado era que
   * la plataforma intentaba transferirle a cuentas que Stripe había
   * restringido, y la transferencia fallaba en el peor momento posible — al
   * devolver el auto.
   */
  private async onConnectedAccountUpdated(
    object: Record<string, unknown>,
    eventId?: string,
  ) {
    const accountId = object.id as string | undefined;
    if (!accountId) return;

    const owner = await this.prisma.user.findUnique({
      where: { stripeAccountId: accountId },
      select: { id: true },
    });
    if (!owner) return;

    const chargesEnabled = object.charges_enabled === true;
    const payoutsEnabled = object.payouts_enabled === true;
    const detailsSubmitted = object.details_submitted === true;

    const status = payoutsEnabled
      ? StripeAccountStatus.ENABLED
      : detailsSubmitted
        ? StripeAccountStatus.RESTRICTED
        : StripeAccountStatus.PENDING;

    await this.prisma.user.update({
      where: { id: owner.id },
      data: { stripeAccountStatus: status },
    });

    await this.prisma.paymentEvent.create({
      data: {
        actorId: null,
        source: "webhook",
        type: "connect.account.updated",
        providerEventId: eventId ?? null,
        payload: {
          accountId,
          chargesEnabled,
          payoutsEnabled,
          detailsSubmitted,
          status,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ── Puerta del retiro ──────────────────────────────────────────────────

  async assertReadyForPickup(bookingId: string): Promise<void> {
    const booking = await this.findBooking(bookingId);
    if (booking.paymentStatus !== PaymentStatus.FULLY_PAID) {
      throw new BadRequestException(
        "Full payment (seña + balance) is required before pickup",
      );
    }
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold) {
      throw new BadRequestException(
        "The security deposit hold must be authorized before pickup",
      );
    }
  }

  // ── Liquidación en la devolución (soltar depósito + pagar al dueño) ────

  /**
   * Los mails de "se cobró parte del depósito", a las dos partes.
   *
   * No hace fallar la captura: la plata ya se movió cuando esto corre, y
   * deshacerla por un mail que no salió sería cambiar un problema chico por
   * uno grande.
   */
  private async avisarDeLaCaptura(
    bookingId: string,
    capturadoMinor: number,
    retenidoMinor: number,
    motivo: string,
  ): Promise<void> {
    try {
      const booking = await this.findBookingWithUsers(bookingId);
      const liberadoMinor = Math.max(0, retenidoMinor - capturadoMinor);
      const nombre = (persona?: {
        displayName?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      }) =>
        persona?.displayName ||
        [persona?.firstName, persona?.lastName].filter(Boolean).join(" ") ||
        "";

      for (const parte of [
        { datos: booking.renter, otra: booking.owner, esDueño: false },
        { datos: booking.owner, otra: booking.renter, esDueño: true },
      ]) {
        if (!parte.datos?.email) continue;
        await this.email.sendDepositCaptured(parte.datos.email, {
          recipientName: nombre(parte.datos),
          esDueño: parte.esDueño,
          otherPartyName: nombre(parte.otra),
          capturado: capturadoMinor / 100,
          liberado: liberadoMinor / 100,
          currency: booking.currency,
          vehicleLabel: this.vehicleLabel(booking),
          motivo,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `No se pudo avisar de la captura del depósito de ${bookingId}: ${message}`,
      );
    }
  }

  /**
   * SOLTAR LA RETENCIÓN DEL DEPÓSITO, SI YA CORRESPONDE.
   *
   * Corresponde cuando la ventana de revisión del dueño se cerró: porque venció
   * sola, o porque alguien la cerró antes (el dueño diciendo que está todo
   * bien, un administrador rechazando un reclamo). Ver claims/claim-window.ts.
   *
   * ── LA REGLA QUE NO SE NEGOCIA ────────────────────────────────────────────
   * Con un reclamo ABIERTO no se suelta nunca, ni con `forzar`. Soltarlo ahí
   * sería resolver el reclamo a favor de una de las partes sin decirlo, y sin
   * que nadie haya mirado las fotos. Quien rechaza un reclamo lo cierra primero
   * y después libera, que es otra cosa y queda escrita.
   *
   * @param opciones.forzar  saltear el plazo (no el reclamo abierto): es lo que
   *        usan "está todo bien" y el rechazo de un reclamo.
   */
  async liberarDepositoSiCorresponde(
    actorId: string,
    bookingId: string,
    opciones: { forzar?: boolean } = {},
  ): Promise<{ liberado: boolean; motivo: string | null }> {
    const booking = await this.findBookingWithUsers(bookingId);

    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold?.stripePaymentIntentId) {
      return { liberado: false, motivo: "sinRetencion" };
    }

    const reclamoAbierto = await this.prisma.damageClaim.findFirst({
      where: { bookingId, status: DamageClaimStatus.OPEN },
      select: { id: true },
    });
    if (reclamoAbierto) {
      return { liberado: false, motivo: "reclamoAbierto" };
    }

    const revision = estadoDeLaRevision({
      status: booking.status,
      returnConfirmedAt: booking.returnConfirmedAt,
      ownerInspectedAt: booking.ownerInspectedAt,
      hayReclamoAbierto: false,
      ahora: new Date(),
    });
    if (!opciones.forzar && !revision.sePuedeLiberar) {
      return { liberado: false, motivo: "ventanaAbierta" };
    }

    await this.provider.releaseHold({
      paymentIntentId: hold.stripePaymentIntentId,
      idempotencyKey: `booking_${bookingId}_deposit_release`,
    });
    const updated = await this.prisma.paymentRecord.update({
      where: { id: hold.id },
      data: { status: PaymentRecordStatus.RELEASED, releasedAt: new Date() },
    });
    await this.recordEvent({
      record: updated,
      bookingId,
      actorId,
      source: "api",
      type: "hold.released",
      status: PaymentRecordStatus.RELEASED,
      amountMinor: hold.amountMinor,
      currency: hold.currency,
    });

    /*
      Y SE LE AVISA, QUE ES LA PARTE QUE FALTABA.

      El depósito es la única plata del alquiler que se ve salir y no se ve
      volver: liberar una retención no genera ningún movimiento en el resumen de
      la tarjeta, así que sin este mail la única señal es que el saldo
      disponible deja de estar recortado. Nadie mira eso. El resultado era gente
      esperando un reembolso que no iba a llegar nunca, porque no había nada que
      reembolsar.
    */
    await this.avisarDeLaLiberacion(booking, hold);
    return { liberado: true, motivo: null };
  }

  /**
   * LO QUE SE COBRÓ POR EL DAÑO VA AL DUEÑO.
   *
   * ── Por qué esto tiene que existir ────────────────────────────────────────
   * Capturar el depósito mueve la plata del inquilino a la plataforma, y ahí se
   * quedaba. O sea que un daño terminaba con el dueño sin auto entero y sin un
   * peso, y con la plataforma cobrando por un perjuicio ajeno. El depósito es
   * una garantía PARA EL DUEÑO: si no le llega, no es una garantía.
   *
   * ── Va entero, sin comisión ───────────────────────────────────────────────
   * La comisión de la plataforma es sobre el alquiler, que es el servicio que
   * presta. Un daño no es un servicio: es un arreglo que el dueño va a pagar.
   * Quedarse con un porcentaje de eso sería cobrarle por haber tenido el
   * problema.
   *
   * No hace fallar la captura: la plata del inquilino ya se movió cuando esto
   * corre, y deshacerla porque el traspaso al dueño falló sería cambiar un
   * problema por dos. Si falla, queda en el log y en la auditoría, y se
   * reintenta con POST /payments/bookings/:id/settle.
   */
  private async transferirElDano(
    actorId: string,
    bookingId: string,
    amountMinor: number,
  ): Promise<void> {
    try {
      const booking = await this.findBookingWithUsers(bookingId);
      const accountId = await this.ensureOwnerAccount(booking.owner);
      const transfer = await this.provider.transferToOwner({
        amountMinor,
        currency: booking.currency,
        destination: accountId,
        transferGroup: booking.transferGroup,
        metadata: { bookingId, motivo: "dano" },
        idempotencyKey: `booking_${bookingId}_damage_${amountMinor}`,
      });

      const payout = await this.prisma.paymentRecord.create({
        data: {
          bookingId,
          userId: booking.ownerId,
          kind: PaymentRecordKind.OWNER_TRANSFER,
          status: PaymentRecordStatus.PAID,
          provider: this.provider.name,
          providerId: transfer.id,
          stripeTransferId: transfer.id,
          amount: amountMinor / 100,
          amountMinor,
          currency: booking.currency,
          paidAt: new Date(),
          metadata: { motivo: "dano" } as Prisma.InputJsonValue,
        },
      });

      await this.recordEvent({
        record: payout,
        bookingId,
        actorId,
        source: "api",
        type: "transfer.created",
        status: PaymentRecordStatus.PAID,
        amountMinor,
        currency: booking.currency,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Se cobró el daño de ${bookingId} pero no se le pudo transferir al ` +
          `dueño: ${message}`,
      );
      await this.auditLog.create({
        actorId,
        action: "payment.damage_transfer_failed",
        entityType: "Booking",
        entityId: bookingId,
        metadata: { amountMinor, reason: message },
      });
    }
  }

  /** "Toyota Corolla 2022", con lo que haya. */
  private vehicleLabel(booking: {
    vehicle?: {
      brand?: string | null;
      model?: string | null;
      year?: number | null;
    } | null;
  }): string {
    return (
      [booking.vehicle?.brand, booking.vehicle?.model, booking.vehicle?.year]
        .filter(Boolean)
        .join(" ") || "el vehículo"
    );
  }

  /**
   * El mail de "se liberó tu depósito".
   *
   * NUNCA HACE FALLAR LA LIQUIDACIÓN: la plata ya se soltó cuando esto corre, y
   * una excepción acá desharía por un mail algo que salió bien. Es el mismo
   * criterio que en el resto de los avisos.
   */
  private async avisarDeLaLiberacion(
    booking: Awaited<ReturnType<PaymentsService["findBookingWithUsers"]>>,
    hold: PaymentRecord,
  ): Promise<void> {
    try {
      if (!booking.renter?.email) return;
      await this.email.sendDepositReleased(booking.renter.email, {
        renterName:
          booking.renter.displayName ??
          `${booking.renter.firstName} ${booking.renter.lastName}`,
        amount: (hold.amountMinor ?? 0) / 100,
        currency: hold.currency ?? booking.currency,
        vehicleLabel: this.vehicleLabel(booking),
        cardBrand: hold.cardBrand,
        cardLast4: hold.cardLast4,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `No se pudo avisar de la liberación del depósito de ${booking.id}: ${message}`,
      );
    }
  }

  /**
   * VOLVER A LIQUIDAR UNA RESERVA QUE QUEDÓ DEVUELTA Y SIN LIQUIDAR.
   *
   * ── Por qué hace falta ────────────────────────────────────────────────────
   * La liquidación corre cuando se confirma la devolución y habla con Stripe
   * dos veces: suelta el depósito y transfiere al dueño. Cualquiera de las dos
   * puede fallar por motivos que no tienen nada que ver con la devolución —el
   * dueño no terminó el alta de cobros, Stripe no contesta— y la devolución no
   * se cae por eso: el auto volvió igual.
   *
   * Pero entonces la reserva queda COMPLETED, con el depósito todavía retenido
   * y el dueño sin cobrar, y no hay forma de volver a intentarlo: confirmar la
   * devolución otra vez no se puede (el código ya se consumió y el estado ya no
   * lo permite). Esto es esa forma.
   *
   * ── Por qué solo un administrador ─────────────────────────────────────────
   * Mueve plata entre dos personas. Es la misma razón por la que capturar el
   * depósito tampoco lo hace el dueño.
   *
   * No duplica nada: el depósito solo se suelta si sigue retenido y la
   * transferencia solo sale si no salió antes.
   */
  async resettle(actorId: string, bookingId: string) {
    const booking = await this.findBooking(bookingId);
    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException({
        statusCode: 400,
        code: "BOOKING_NOT_COMPLETED",
        message:
          "Solo se liquida una reserva ya devuelta. Esta todavía no lo está.",
      });
    }
    await this.settleOnReturn(actorId, bookingId);
    return { settled: true, bookingId };
  }

  async settleOnReturn(actorId: string, bookingId: string) {
    const booking = await this.findBookingWithUsers(bookingId);

    // NO SE LIQUIDA UNA RESERVA CON UNA DISPUTA ABIERTA.
    //
    // Transferirle al dueño plata que el banco del inquilino puede reclamar de
    // vuelta convierte una disputa en una pérdida: la plataforma devuelve el
    // cobro y ya le pagó al dueño. Frenar la liquidación es lo único que deja
    // la plata donde se la puede defender.
    const disputado = await this.prisma.paymentRecord.findFirst({
      where: { bookingId, status: PaymentRecordStatus.DISPUTED },
      select: { id: true },
    });
    if (disputado) {
      this.logger.error(
        `la reserva ${bookingId} tiene un cobro disputado: no se liquida`,
      );
      throw new BadRequestException({
        statusCode: 400,
        code: "PAYMENT_DISPUTED",
        message:
          "Hay un pago de esta reserva desconocido por el titular de la " +
          "tarjeta. La liquidación queda frenada hasta que se resuelva.",
      });
    }

    /*
      EL DEPÓSITO YA NO SE SUELTA ACÁ, Y ES EL CAMBIO IMPORTANTE.

      Se soltaba en el mismo instante en que se confirmaba la devolución, y eso
      dejaba el reclamo por daños en una situación imposible: cuando el dueño se
      acercaba al auto y veía el golpe, la retención ya no existía y no había
      nada que capturar. El depósito servía para todo menos para lo único que
      existe.

      Ahora queda retenido mientras dura la ventana de revisión del dueño
      —48 horas— y se suelta cuando pasa algo: el dueño dice que está todo bien,
      un administrador rechaza un reclamo, o la ventana vence. Ver
      claims/claim-window.ts, que explica por qué no hay nadie que lo suelte
      solo y por qué la plata igual nunca queda trabada.

      Se llama igual, por si esto corre desde un reintento posterior con la
      ventana ya vencida: ahí sí corresponde soltarlo.
    */
    await this.liberarDepositoSiCorresponde(actorId, bookingId);

    /*
      TRANSFERIR AL DUEÑO LO QUE LE CORRESPONDE, UNA SOLA VEZ.

      La guarda no es decorativa: esto se puede volver a correr. La devolución
      del auto ya no se cae cuando la liquidación falla (ver
      BookingsService.confirmReturn), así que una reserva puede quedar
      devuelta y sin liquidar, y alguien la tiene que poder reintentar.

      Sin la guarda, el reintento de una reserva que SÍ había transferido
      escribía un segundo registro de pago por el mismo dinero. La clave de
      idempotencia hace que Stripe devuelva la transferencia original en vez de
      mandar la plata dos veces —eso estaba bien—, pero la contabilidad de este
      lado quedaba contando el doble.
    */
    const amountMinor = Math.round((booking.ownerPayoutSnapshot ?? 0) * 100);
    const yaTransferido =
      Boolean(booking.ownerTransferId) ||
      (await this.prisma.paymentRecord.findFirst({
        where: { bookingId, kind: PaymentRecordKind.OWNER_TRANSFER },
        select: { id: true },
      })) !== null;

    if (amountMinor > 0 && !yaTransferido) {
      // El alta de la cuenta del dueño se pide acá adentro y no antes: si ya
      // se transfirió, no hay nada que dar de alta y era una llamada al
      // procesador en cada reintento.
      const accountId = await this.ensureOwnerAccount(booking.owner);
      const transfer = await this.provider.transferToOwner({
        amountMinor,
        currency: booking.currency,
        destination: accountId,
        transferGroup: booking.transferGroup,
        metadata: { bookingId },
        idempotencyKey: `booking_${bookingId}_owner_transfer`,
      });

      const [payout] = await this.prisma.$transaction([
        this.prisma.paymentRecord.create({
          data: {
            bookingId,
            userId: booking.ownerId,
            kind: PaymentRecordKind.OWNER_TRANSFER,
            status: PaymentRecordStatus.PAID,
            provider: this.provider.name,
            providerId: transfer.id,
            stripeTransferId: transfer.id,
            amount: amountMinor / 100,
            amountMinor,
            currency: booking.currency,
            paidAt: new Date(),
          },
        }),
        this.prisma.booking.update({
          where: { id: bookingId },
          data: { ownerTransferId: transfer.id },
        }),
      ]);

      await this.recordEvent({
        record: payout,
        bookingId,
        actorId,
        source: "api",
        type: "transfer.created",
        status: PaymentRecordStatus.PAID,
        amountMinor,
        currency: booking.currency,
      });
    }

    await this.auditLog.create({
      actorId,
      targetUserId: booking.ownerId,
      action: "payment.settled",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { ownerPayoutMinor: amountMinor },
    });
  }

  /**
   * COBRAR PARTE DEL DEPÓSITO EN GARANTÍA POR UN DAÑO.
   *
   * Es la otra mitad del depósito, y hasta ahora no existía: la retención solo
   * se podía soltar, así que un auto devuelto con un golpe no tenía forma de
   * cobrarse y el depósito era decorativo.
   *
   * ── Por qué lo ejecuta un administrador y no el dueño ────────────────────
   * Es plata de otra persona y la decisión tiene dos partes interesadas con
   * intereses opuestos. Dejar que el dueño capture solo convertiría el
   * depósito en un botón para quedarse con $200 de quien alquiló, sin que
   * nadie mire. El dueño reclama, la plataforma resuelve — que es lo que la
   * plataforma está para hacer.
   *
   * El importe se acota al retenido: no se puede capturar más de lo que se
   * bloqueó, y Stripe además lo rechazaría.
   */
  async captureDeposit(
    actorId: string,
    bookingId: string,
    amountMinor: number,
    reason: string,
    ctx: PaymentContext = {},
  ) {
    const booking = await this.findBooking(bookingId);
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (!hold?.stripePaymentIntentId) {
      throw new BadRequestException({
        statusCode: 400,
        code: "DEPOSIT_HOLD_NOT_AVAILABLE",
        message:
          "Esta reserva no tiene un depósito retenido para cobrar. Puede que " +
          "ya se haya soltado o que nunca se haya autorizado.",
      });
    }

    const retenido = hold.amountMinor ?? 0;
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: "INVALID_AMOUNT",
        message: "El importe a cobrar tiene que ser un número positivo.",
      });
    }
    if (amountMinor > retenido) {
      throw new BadRequestException({
        statusCode: 400,
        code: "AMOUNT_EXCEEDS_HOLD",
        message: `No se puede cobrar más de lo retenido (${retenido / 100} ${hold.currency.toUpperCase()}).`,
      });
    }

    const captured = await this.provider.captureHold({
      paymentIntentId: hold.stripePaymentIntentId,
      amountMinor,
      idempotencyKey: `booking_${bookingId}_deposit_capture_${amountMinor}`,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.paymentRecord.update({
        where: { id: hold.id },
        data: {
          status: PaymentRecordStatus.CAPTURED,
          amount: amountMinor / 100,
          amountMinor,
          capturedAt: new Date(),
          paidAt: new Date(),
          stripeChargeId: captured.chargeId ?? undefined,
          metadata: {
            ...((hold.metadata as Record<string, unknown> | null) ?? {}),
            depositHeldMinor: retenido,
            captureReason: reason,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.booking.update({
        where: { id: bookingId },
        data: { depositCapturedAmount: amountMinor / 100 },
      });
      return actualizado;
    });

    await this.recordEvent({
      record: updated,
      bookingId,
      actorId,
      source: "api",
      type: "hold.captured",
      status: PaymentRecordStatus.CAPTURED,
      amountMinor,
      currency: hold.currency,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      payload: { reason, heldMinor: retenido },
    });

    await this.auditLog.create({
      actorId,
      targetUserId: booking.renterId,
      action: "payment.deposit.captured",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { amountMinor, heldMinor: retenido, reason },
    });

    /*
      Y SE LES AVISA A LAS DOS PARTES, QUE ES LO QUE FALTABA.

      Cobrar parte del depósito sin avisar es la peor cosa que hace un sistema
      de pagos: alguien esperando que le vuelvan doscientos dólares descubre
      tres días después, mirando el resumen, que le cobraron sesenta, sin saber
      por qué ni a quién preguntarle. El motivo lo escribió quien resolvió el
      reclamo y viaja entero, sin recortar: es lo que esa persona va a leer
      para decidir si está de acuerdo.
    */
    await this.avisarDeLaCaptura(bookingId, amountMinor, retenido, reason);

    // Y lo cobrado va al dueño, que es de quien es la garantía.
    await this.transferirElDano(actorId, bookingId, amountMinor);

    return this.getStatus(actorId, bookingId).catch(() => ({
      bookingId,
      capturedMinor: amountMinor,
    }));
  }

  // ── Devolución al cancelar ─────────────────────────────────────────────

  /**
   * @param opciones.retenerSena  la seña NO se devuelve. Lo decide la política
   *        de cancelación (bookings/cancellation-policy.ts): cancelar sobre la
   *        fecha deja al dueño sin el alquiler y sin poder realquilar esos
   *        días, y la seña es justamente lo que se paga para reservarlos.
   */
  async refundOnCancel(
    actorId: string,
    bookingId: string,
    opciones: { retenerSena?: boolean } = {},
  ) {
    const booking = await this.findBookingWithUsers(bookingId);
    const devolver: PaymentRecordKind[] = opciones.retenerSena
      ? [PaymentRecordKind.BALANCE]
      : [PaymentRecordKind.SENA, PaymentRecordKind.BALANCE];
    const charged = await this.prisma.paymentRecord.findMany({
      where: {
        bookingId,
        kind: { in: devolver },
        status: { in: PAID_RECORD_STATUSES },
      },
    });

    for (const record of charged) {
      if (!record.stripePaymentIntentId) continue;
      // Lo que queda por devolver, no el importe original: un cobro que ya
      // tuvo una devolución parcial no se devuelve entero otra vez.
      const pendienteMinor =
        (record.amountMinor ?? 0) - (record.refundedAmountMinor ?? 0);
      if (pendienteMinor <= 0) continue;

      const refund = await this.provider.refund({
        paymentIntentId: record.stripePaymentIntentId,
        amountMinor: pendienteMinor,
        idempotencyKey: `booking_${bookingId}_${record.kind}_refund_${pendienteMinor}`,
      });
      const [updated, comprobante] = await this.prisma.$transaction([
        this.prisma.paymentRecord.update({
          where: { id: record.id },
          data: {
            status: PaymentRecordStatus.REFUNDED,
            refundedAmountMinor:
              (record.refundedAmountMinor ?? 0) + pendienteMinor,
            refundedAt: new Date(),
          },
        }),
        this.prisma.paymentRecord.create({
          data: {
            bookingId,
            userId: record.userId,
            kind: PaymentRecordKind.REFUND,
            status: PaymentRecordStatus.REFUNDED,
            provider: this.provider.name,
            providerId: refund.id,
            stripeRefundId: refund.id,
            amount: pendienteMinor / 100,
            amountMinor: pendienteMinor,
            currency: record.currency,
            refundedAt: new Date(),
          },
        }),
      ]);
      void updated;

      await this.recordEvent({
        record: comprobante,
        bookingId,
        actorId,
        source: "api",
        type: "refund.created",
        status: PaymentRecordStatus.REFUNDED,
        amountMinor: pendienteMinor,
        currency: record.currency,
      });
    }

    // Soltar la retención del depósito, si estaba autorizada.
    const hold = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId,
        kind: PaymentRecordKind.DEPOSIT_HOLD,
        status: PaymentRecordStatus.AUTHORIZED,
      },
    });
    if (hold?.stripePaymentIntentId) {
      await this.provider.releaseHold({
        paymentIntentId: hold.stripePaymentIntentId,
        idempotencyKey: `booking_${bookingId}_deposit_release`,
      });
      const updated = await this.prisma.paymentRecord.update({
        where: { id: hold.id },
        data: {
          status: PaymentRecordStatus.RELEASED,
          releasedAt: new Date(),
        },
      });
      await this.recordEvent({
        record: updated,
        bookingId,
        actorId,
        source: "api",
        type: "hold.released",
        status: PaymentRecordStatus.RELEASED,
        amountMinor: hold.amountMinor,
        currency: hold.currency,
      });
    }

    if (charged.length > 0) {
      await this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          paymentStatus: opciones.retenerSena
            ? PaymentStatus.PARTIALLY_REFUNDED
            : PaymentStatus.REFUNDED,
          refundedAt: new Date(),
        },
      });
    }

    // La seña retenida es del DUEÑO, no de la plataforma.
    if (opciones.retenerSena) {
      await this.transferirLaSenaRetenida(actorId, booking);
    }

    await this.auditLog.create({
      actorId,
      targetUserId: booking.ownerId,
      action: "payment.refunded",
      entityType: "Booking",
      entityId: bookingId,
      metadata: {
        refunded: charged.length,
        retuvoSena: Boolean(opciones.retenerSena),
      },
    });
  }

  /**
   * LA SEÑA QUE NO SE DEVOLVIÓ VA AL DUEÑO.
   *
   * Sin esto, "se retiene la seña" significaría que se la queda la plataforma,
   * que no es ni justo ni lo que dice la política: lo que la seña compensa es
   * al dueño, que quedó sin el alquiler y con las fechas bloqueadas hasta el
   * último momento. Quedársela sería cobrar por el perjuicio de otro.
   *
   * ── Cuánto ────────────────────────────────────────────────────────────────
   * La misma proporción que le tocaba del alquiler entero. La reserva ya la
   * tiene calculada: `ownerPayoutSnapshot` sobre `totalPriceSnapshot` es lo que
   * queda para el dueño después de la comisión y el seguro, así que aplicarla
   * sobre la seña le deja al dueño su parte y a la plataforma la suya, sin
   * inventar una cuenta nueva.
   *
   * ── Una sola vez ──────────────────────────────────────────────────────────
   * Misma guarda que en la liquidación del final: si esta reserva ya transfirió
   * —no debería, pero una reserva se cancela una sola vez y el código se puede
   * reintentar— no sale otra.
   */
  private async transferirLaSenaRetenida(
    actorId: string,
    booking: Awaited<ReturnType<PaymentsService["findBookingWithUsers"]>>,
  ): Promise<void> {
    if (booking.ownerTransferId) return;

    const sena = await this.prisma.paymentRecord.findFirst({
      where: {
        bookingId: booking.id,
        kind: PaymentRecordKind.SENA,
        status: { in: PAID_RECORD_STATUSES },
      },
      orderBy: { createdAt: "desc" },
    });
    const retenidoMinor =
      (sena?.amountMinor ?? 0) - (sena?.refundedAmountMinor ?? 0);
    if (retenidoMinor <= 0) return;

    const total = booking.totalPriceSnapshot ?? 0;
    const alDueno = booking.ownerPayoutSnapshot ?? 0;
    const proporcion = total > 0 ? alDueno / total : 0;
    const amountMinor = Math.round(retenidoMinor * proporcion);
    if (amountMinor <= 0) return;

    const accountId = await this.ensureOwnerAccount(booking.owner);
    const transfer = await this.provider.transferToOwner({
      amountMinor,
      currency: booking.currency,
      destination: accountId,
      transferGroup: booking.transferGroup,
      metadata: { bookingId: booking.id, motivo: "sena_retenida" },
      idempotencyKey: `booking_${booking.id}_cancel_transfer`,
    });

    const [payout] = await this.prisma.$transaction([
      this.prisma.paymentRecord.create({
        data: {
          bookingId: booking.id,
          userId: booking.ownerId,
          kind: PaymentRecordKind.OWNER_TRANSFER,
          status: PaymentRecordStatus.PAID,
          provider: this.provider.name,
          providerId: transfer.id,
          stripeTransferId: transfer.id,
          amount: amountMinor / 100,
          amountMinor,
          currency: booking.currency,
          paidAt: new Date(),
        },
      }),
      this.prisma.booking.update({
        where: { id: booking.id },
        data: { ownerTransferId: transfer.id },
      }),
    ]);

    await this.recordEvent({
      record: payout,
      bookingId: booking.id,
      actorId,
      source: "api",
      type: "transfer.created",
      status: PaymentRecordStatus.PAID,
      amountMinor,
      currency: booking.currency,
    });
  }

  // ── Alta del dueño en Connect ──────────────────────────────────────────

  async createOwnerOnboarding(ownerId: string) {
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId } });
    assertFound(owner, "User not found");

    const frontend =
      this.config.get<string>("FRONTEND_URL") ?? "http://localhost:3000";
    const result = await this.provider.createConnectedAccount({
      userId: owner.id,
      email: owner.email,
      refreshUrl: `${frontend}/connect/refresh`,
      returnUrl: `${frontend}/connect/return`,
    });

    await this.prisma.user.update({
      where: { id: owner.id },
      data: {
        stripeAccountId: result.accountId,
        stripeAccountStatus: StripeAccountStatus.PENDING,
      },
    });

    return { accountId: result.accountId, onboardingUrl: result.onboardingUrl };
  }

  /**
   * El estado de cobro del dueño, consultado al procesador.
   *
   * El front lo necesita para poder decir "todavía te falta completar tus
   * datos en Stripe" antes de que alguien publique un auto y descubra recién
   * al devolverlo que no puede cobrar.
   */
  async getOwnerPayoutStatus(ownerId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { stripeAccountId: true, stripeAccountStatus: true },
    });
    assertFound(owner, "User not found");

    /*
      Una cuenta que quedó de la simulación se trata como "todavía no tiene".

      Preguntarle por ella a Stripe da "No such account", y decirle a alguien
      que su cuenta de cobro está rota cuando lo que hay que hacer es crearla
      lo manda a buscar un problema que no existe. Así, el front le ofrece
      hacer el alta, que es exactamente lo que corresponde.

      El identificador se copia a una constante para que TypeScript sepa que
      después del `if` ya no puede ser null: la comprobación es una llamada a
      un método, y eso no alcanza para que estreche el tipo solo.
    */
    const cuentaDeCobro = owner.stripeAccountId;
    if (!this.esDelProveedorActual(cuentaDeCobro)) {
      return {
        connected: false,
        status: StripeAccountStatus.NONE,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      };
    }

    const estado = await this.provider.getConnectedAccountStatus(
      cuentaDeCobro as string,
    );
    const status = estado.payoutsEnabled
      ? StripeAccountStatus.ENABLED
      : estado.detailsSubmitted
        ? StripeAccountStatus.RESTRICTED
        : StripeAccountStatus.PENDING;

    if (status !== owner.stripeAccountStatus) {
      await this.prisma.user.update({
        where: { id: ownerId },
        data: { stripeAccountStatus: status },
      });
    }

    return { connected: true, status, ...estado };
  }

  // ── Registro append-only ───────────────────────────────────────────────

  /**
   * Anota una línea en el registro de lo que le pasó a un cobro.
   *
   * NUNCA HACE FALLAR LA OPERACIÓN QUE LA MOTIVÓ. Es deliberado y vale la pena
   * ser explícito: el registro es importante, pero revertir un cobro que ya se
   * hizo porque no se pudo escribir una línea de auditoría sería cambiar un
   * problema de trazabilidad por uno de plata. Si falla, queda gritado en el
   * log, que es donde alguien lo va a ver.
   */
  private async recordEvent(input: {
    record?: PaymentRecord | null;
    bookingId?: string | null;
    actorId?: string | null;
    source: "api" | "webhook" | "system";
    type: string;
    status?: PaymentRecordStatus;
    amountMinor?: number | null;
    currency?: string | null;
    providerEventId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    payload?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      await this.prisma.paymentEvent.create({
        data: {
          paymentRecordId: input.record?.id ?? null,
          bookingId: input.bookingId ?? input.record?.bookingId ?? null,
          actorId: input.actorId ?? null,
          source: input.source,
          type: input.type,
          status: input.status ?? null,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency ?? null,
          // El id del evento del procesador lleva el tipo pegado: un mismo
          // evento de Stripe puede producir más de una línea (el cobro y el
          // aviso), y el unique las haría chocar.
          providerEventId: input.providerEventId
            ? `${input.providerEventId}:${input.type}`
            : null,
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          payload: (input.payload ?? undefined) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return; // El mismo evento ya quedó anotado: es el caso normal de un reintento.
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `no se pudo anotar el evento ${input.type} del cobro ` +
          `${input.record?.id ?? "(sin registro)"}: ${message}`,
      );
    }
  }

  /**
   * El historial completo de una reserva: cada línea, en orden.
   *
   * Lo ven las dos partes de la reserva y los administradores. Va SIN las
   * señas de la tarjeta ni la IP para quien no es administrador: al inquilino
   * le sirve ver qué pasó y cuándo, no de qué IP se pagó.
   */
  async getLedger(userId: string, bookingId: string, isAdmin: boolean) {
    await this.findBookingForParticipant(userId, bookingId);
    const events = await this.prisma.paymentEvent.findMany({
      where: { bookingId },
      orderBy: { createdAt: "asc" },
    });
    return events.map((event) => ({
      id: event.id,
      type: event.type,
      status: event.status,
      amountMinor: event.amountMinor,
      currency: event.currency,
      source: event.source,
      createdAt: event.createdAt,
      ...(isAdmin
        ? { ip: event.ip, userAgent: event.userAgent, payload: event.payload }
        : {}),
    }));
  }

  // ── Ayudantes ──────────────────────────────────────────────────────────

  /**
   * Consulta el intent y NO LANZA: si el procesador no contesta, se sigue con
   * lo que ya se sabe.
   *
   * Es una consulta para enriquecer el registro, no para decidir. Hacerla
   * obligatoria significaría que una caída momentánea de Stripe deje un cobro
   * exitoso sin aplicar, que es exactamente al revés de lo que conviene.
   */
  private async safeRetrieve(
    paymentIntentId: string,
  ): Promise<PaymentIntentResult | null> {
    try {
      return await this.provider.retrieveIntent(paymentIntentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `no se pudo consultar el intent ${paymentIntentId}: ${message}`,
      );
      return null;
    }
  }

  /** Si este deploy está configurado para mover plata de verdad. */
  private enModoReal(): boolean {
    return /^(sk|rk)_live_/.test(
      this.config.get<string>("STRIPE_SECRET_KEY") ?? "",
    );
  }

  /**
   * SI UN IDENTIFICADOR GUARDADO LO CREÓ EL PROVEEDOR QUE ESTÁ CORRIENDO HOY.
   *
   * ── El problema que esto resuelve ────────────────────────────────────────
   * Los identificadores de cliente y de cuenta se guardan en la base la
   * primera vez y se reusan siempre. Eso está bien mientras el proveedor no
   * cambie. Pero este deploy corrió un tiempo con PAYMENTS_PROVIDER=mock, y el
   * proveedor de simulación inventa identificadores propios —`cus_mock_…`,
   * `acct_mock_…`— que quedaron escritos en las filas de quienes usaron la app
   * en ese momento.
   *
   * Al pasar a Stripe de verdad, esas filas siguen teniendo el identificador
   * viejo. Se reusa, se le manda a Stripe, y Stripe contesta lo único que
   * puede contestar: "No such customer: 'cus_mock_…'". El cobro falla, y no
   * hay nada en la app que explique por qué: la cuenta parece normal y la
   * tarjeta es válida.
   *
   * No se arregla borrando esas filas a mano, porque vuelve a pasar con cada
   * cuenta que quede de un modo anterior. Se arregla acá: un identificador que
   * no es de este proveedor vale lo mismo que no tener ninguno, y se crea uno
   * nuevo.
   *
   * Sirve para los dos lados: un identificador real guardado mientras corre la
   * simulación también es inservible, y esta misma cuenta lo detecta.
   *
   * ── Lo que NO detecta ────────────────────────────────────────────────────
   * Un identificador de OTRA cuenta de Stripe (si se cambia la clave secreta
   * por la de otra cuenta). Eso solo se sabe preguntándole a Stripe, que es
   * una llamada de red en cada cobro para un caso que pasa una vez en la vida.
   * Cuando pasa, el filtro de errores ya lo dice con todas las letras.
   */
  private esDelProveedorActual(id: string | null | undefined): boolean {
    if (!id) return false;
    const deSimulacion = id.includes("_mock_");
    return deSimulacion === (this.provider.name === "mock");
  }

  private async ensureRenterCustomer(renter: User): Promise<string> {
    if (this.esDelProveedorActual(renter.stripeCustomerId)) {
      return renter.stripeCustomerId as string;
    }
    const customerId = await this.provider.ensureCustomer({
      userId: renter.id,
      email: renter.email,
      name: renter.displayName ?? `${renter.firstName} ${renter.lastName}`,
    });
    await this.prisma.user.update({
      where: { id: renter.id },
      data: { stripeCustomerId: customerId },
    });
    return customerId;
  }

  private async ensureOwnerAccount(owner: User): Promise<string> {
    // Mismo caso que en ensureRenterCustomer: una `acct_mock_…` guardada
    // cuando corría la simulación hace fallar la transferencia al dueño al
    // final del alquiler, que es el peor momento para enterarse.
    if (this.esDelProveedorActual(owner.stripeAccountId)) {
      return owner.stripeAccountId as string;
    }
    const account = await this.provider.createConnectedAccount({
      userId: owner.id,
      email: owner.email,
    });
    await this.prisma.user.update({
      where: { id: owner.id },
      data: {
        stripeAccountId: account.accountId,
        // PENDING y no ENABLED: una cuenta recién creada NO puede recibir
        // plata hasta que su dueño complete el alta con Stripe. Marcarla como
        // habilitada era una mentira que se descubría al fallar la primera
        // transferencia; el estado real llega por el webhook account.updated.
        stripeAccountStatus: StripeAccountStatus.PENDING,
      },
    });
    return account.accountId;
  }

  private async findBooking(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    assertFound(booking, "Booking not found");
    return booking;
  }

  private async findBookingWithUsers(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      // El vehículo viene para poder nombrarlo en los mails: "se liberó tu
      // depósito de Toyota Corolla 2022" dice de cuál de las tres reservas
      // está hablando, y "se liberó tu depósito" no.
      include: { owner: true, renter: true, vehicle: true },
    });
    assertFound(booking, "Booking not found");
    return booking;
  }

  private async findBookingForParticipant(userId: string, bookingId: string) {
    const booking = await this.findBooking(bookingId);
    assertParticipant(
      booking.ownerId,
      booking.renterId,
      userId,
      "You cannot access this payment",
    );
    return booking;
  }
}

/** Las columnas de tarjeta y riesgo, solo cuando hay algo que escribir. */
function cardColumns(detalle: PaymentIntentResult | null) {
  if (!detalle) return {};
  return {
    ...(detalle.card
      ? {
          cardBrand: detalle.card.brand,
          cardLast4: detalle.card.last4,
          cardFingerprint: detalle.card.fingerprint,
          cardCountry: detalle.card.country,
        }
      : {}),
    ...(detalle.risk
      ? { riskLevel: detalle.risk.level, riskScore: detalle.risk.score }
      : {}),
  };
}

/**
 * UN COBRO, COMO LO VE QUIEN PARTICIPA DE LA RESERVA.
 *
 * La fila completa NO se devuelve, y el motivo es concreto: desde que el
 * registro guarda el fingerprint de la tarjeta, la IP y el navegador de quien
 * pagó, devolverla entera le mostraría al dueño del auto desde dónde se conecta
 * quien se lo alquiló. Eso es vigilancia, no información de pago.
 *
 * Lo que queda es lo que sirve para entender el cobro: cuánto, cuándo, en qué
 * estado, con qué tarjeta (marca y últimos cuatro, que es lo que la persona
 * necesita para reconocerla en su resumen) y por qué falló si falló.
 */
function publicRecord(record: PaymentRecord) {
  return {
    id: record.id,
    bookingId: record.bookingId,
    kind: record.kind,
    status: record.status,
    amount: record.amount,
    amountMinor: record.amountMinor,
    refundedAmountMinor: record.refundedAmountMinor,
    currency: record.currency,
    cardBrand: record.cardBrand,
    cardLast4: record.cardLast4,
    failureCode: record.failureCode,
    failureMessage: record.failureMessage,
    paidAt: record.paidAt,
    capturedAt: record.capturedAt,
    releasedAt: record.releasedAt,
    refundedAt: record.refundedAt,
    disputedAt: record.disputedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
