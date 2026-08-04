import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BookingStatus,
  VerificationCodePurpose,
  VerificationCodeTargetType,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { assertFound } from "../common/utils/entity.util";
import { assertOwner } from "../common/utils/authorization.util";
import {
  consumeVerificationCode,
  generateNumericCode,
  VERIFICATION_CODE_TTL_MS,
} from "../common/utils/verification-code.util";

/**
 * Cambiar el PRECIO de una publicación no es lo mismo que corregir una coma en la
 * descripción, y hasta ahora costaba exactamente lo mismo: un PATCH y listo.
 *
 * Cómo lo resuelven las apps que manejan plata (Mercado Libre con los datos de
 * cobro, los bancos con los límites, Airbnb con la tarifa): un cambio sensible
 * pide una confirmación por un segundo canal y no se puede repetir a cada rato.
 * Acá se aplican las tres defensas que tienen sentido para este caso:
 *
 *   1. CÓDIGO POR EMAIL. El precio nuevo queda guardado como "pendiente" y recién
 *      se aplica cuando la persona confirma con el código de 6 dígitos que le
 *      llega a su casilla. Si alguien entra con la sesión abierta en una
 *      computadora ajena, no puede rematar el auto sin acceso al mail.
 *   2. TIEMPO DE ESPERA ENTRE CAMBIOS. Un cambio por día. Evita el precio que
 *      sube y baja para aparecer más arriba en el listado.
 *   3. NADA DE CAMBIOS CON RESERVAS EN CURSO. Si hay una reserva pedida o
 *      aceptada, el precio queda congelado: cambiarlo debajo de alguien que ya
 *      reservó es justamente lo que no puede pasar.
 *
 * Los precios de las reservas ya hechas nunca se tocan: cada reserva guarda su
 * propio total (totalPriceSnapshot), así que esto solo afecta a las próximas.
 */

/** Reservas que congelan el precio mientras están vivas. */
const ACTIVE_BOOKING_STATUSES: BookingStatus[] = [
  BookingStatus.REQUESTED,
  BookingStatus.ACCEPTED,
  BookingStatus.READY_FOR_PICKUP,
  BookingStatus.IN_PROGRESS,
  BookingStatus.RETURN_PENDING,
];

const DEFAULT_COOLDOWN_HOURS = 24;

@Injectable()
export class PriceChangeService {
  private readonly logger = new Logger(PriceChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** Horas que hay que esperar entre dos cambios de precio. */
  private get cooldownHours(): number {
    const raw = Number(this.config.get<string>("PRICE_CHANGE_COOLDOWN_HOURS"));
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_COOLDOWN_HOURS;
  }

  /**
   * Paso 1: se pide el cambio. Se valida todo, se guarda el precio nuevo como
   * pendiente y se manda el código al email.
   */
  async request(ownerId: string, listingId: string, newPrice: number) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });
    assertFound(listing, "Listing not found");
    assertOwner(listing.ownerId, ownerId, "No es tu publicación");

    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      throw new BadRequestException("El precio tiene que ser mayor a cero");
    }

    if (Math.round(newPrice) === Math.round(listing.pricePerDay)) {
      throw new BadRequestException("El precio es el mismo que el actual");
    }

    await this.assertNoActiveBookings(listingId);
    this.assertCooldownElapsed(listing.priceUpdatedAt);

    const user = await this.prisma.user.findUnique({ where: { id: ownerId } });
    assertFound(user, "User not found");

    const code = generateNumericCode();
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

    // Se anulan los códigos de cambio de precio que hubieran quedado abiertos.
    await this.prisma.verificationCode.updateMany({
      where: {
        userId: ownerId,
        purpose: VerificationCodePurpose.PRICE_CHANGE,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    await this.prisma.$transaction([
      this.prisma.verificationCode.create({
        data: {
          userId: ownerId,
          targetType: VerificationCodeTargetType.EMAIL,
          targetValue: user.email,
          purpose: VerificationCodePurpose.PRICE_CHANGE,
          codeHash: await bcrypt.hash(code, 10),
          expiresAt,
        },
      }),
      this.prisma.listing.update({
        where: { id: listingId },
        data: {
          pendingPricePerDay: newPrice,
          priceChangeRequestedAt: new Date(),
        },
      }),
    ]);

    await this.emailService.sendPriceChangeCode(
      user.email,
      listing.title,
      listing.pricePerDay,
      newPrice,
      code,
    );

    if (process.env.NODE_ENV !== "production") {
      this.logger.debug(
        `Código de cambio de precio para ${user.email}: ${code}`,
      );
    }

    return {
      requested: true as const,
      expiresAt,
      sentTo: user.email,
      currentPricePerDay: listing.pricePerDay,
      pendingPricePerDay: newPrice,
    };
  }

  /** Paso 2: con el código correcto, el precio pendiente pasa a ser el precio. */
  async confirm(ownerId: string, listingId: string, code: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });
    assertFound(listing, "Listing not found");
    assertOwner(listing.ownerId, ownerId, "No es tu publicación");

    if (listing.pendingPricePerDay === null) {
      throw new BadRequestException("No hay ningún cambio de precio pendiente");
    }

    await consumeVerificationCode(this.prisma, {
      where: {
        userId: ownerId,
        purpose: VerificationCodePurpose.PRICE_CHANGE,
      },
      plaintext: code,
      errors: {
        missing: () =>
          new BadRequestException("No encontramos el código. Pedí uno nuevo."),
        expired: () =>
          new BadRequestException("El código venció. Pedí uno nuevo."),
        tooManyAttempts: () =>
          new ForbiddenException("Demasiados intentos. Pedí un código nuevo."),
        invalid: () => new BadRequestException("El código no es correcto"),
      },
    });

    // Se vuelve a revisar: entre el pedido y la confirmación pudo entrar una
    // reserva.
    await this.assertNoActiveBookings(listingId);

    const updated = await this.prisma.listing.update({
      where: { id: listingId },
      data: {
        pricePerDay: listing.pendingPricePerDay,
        pendingPricePerDay: null,
        priceChangeRequestedAt: null,
        priceUpdatedAt: new Date(),
      },
    });

    this.logger.log(
      `Precio de ${listingId}: ${listing.pricePerDay} → ${updated.pricePerDay}`,
    );
    return {
      confirmed: true as const,
      pricePerDay: updated.pricePerDay,
    };
  }

  /** Se descarta el cambio pendiente. */
  async cancel(ownerId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });
    assertFound(listing, "Listing not found");
    assertOwner(listing.ownerId, ownerId, "No es tu publicación");

    await this.prisma.$transaction([
      this.prisma.verificationCode.updateMany({
        where: {
          userId: ownerId,
          purpose: VerificationCodePurpose.PRICE_CHANGE,
          consumedAt: null,
        },
        data: { consumedAt: new Date() },
      }),
      this.prisma.listing.update({
        where: { id: listingId },
        data: { pendingPricePerDay: null, priceChangeRequestedAt: null },
      }),
    ]);

    return { cancelled: true as const };
  }

  /**
   * Estado del precio para la pantalla del dueño: si se puede cambiar ahora, y si
   * no, por qué. Así el botón puede explicar el motivo en vez de fallar al tocarlo.
   */
  async status(ownerId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });
    assertFound(listing, "Listing not found");
    assertOwner(listing.ownerId, ownerId, "No es tu publicación");

    const activeBookings = await this.prisma.booking.count({
      where: { listingId, status: { in: ACTIVE_BOOKING_STATUSES } },
    });

    const nextAllowedAt = this.nextAllowedChangeAt(listing.priceUpdatedAt);
    const cooldownActive = nextAllowedAt !== null && nextAllowedAt > new Date();

    return {
      pricePerDay: listing.pricePerDay,
      pendingPricePerDay: listing.pendingPricePerDay,
      priceChangeRequestedAt: listing.priceChangeRequestedAt,
      canChange: activeBookings === 0 && !cooldownActive,
      blockedByBookings: activeBookings > 0,
      activeBookings,
      cooldownHours: this.cooldownHours,
      nextAllowedChangeAt: cooldownActive ? nextAllowedAt : null,
    };
  }

  private async assertNoActiveBookings(listingId: string) {
    const active = await this.prisma.booking.count({
      where: { listingId, status: { in: ACTIVE_BOOKING_STATUSES } },
    });

    if (active > 0) {
      throw new BadRequestException(
        "No se puede cambiar el precio con reservas en curso. " +
          "Esperá a que terminen o cancelalas.",
      );
    }
  }

  private assertCooldownElapsed(lastChange: Date | null) {
    const nextAllowed = this.nextAllowedChangeAt(lastChange);
    if (nextAllowed && nextAllowed > new Date()) {
      const hours = Math.ceil(
        (nextAllowed.getTime() - Date.now()) / (60 * 60 * 1000),
      );
      throw new BadRequestException(
        `El precio se puede cambiar una vez cada ${this.cooldownHours} horas. ` +
          `Volvé a intentar en ${hours} hora${hours === 1 ? "" : "s"}.`,
      );
    }
  }

  /** Cuándo se puede volver a cambiar, o null si nunca cambió. */
  private nextAllowedChangeAt(lastChange: Date | null): Date | null {
    if (!lastChange) return null;
    return new Date(lastChange.getTime() + this.cooldownHours * 60 * 60 * 1000);
  }
}
