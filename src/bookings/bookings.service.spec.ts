import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, ListingStatus, PaymentStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { AvailabilityService } from "../availability/availability.service";
import { AuditLogService } from "../common/services/audit-log.service";
import { ContractsService } from "../contracts/contracts.service";
import { EmailService } from "../email/email.service";
import { ConfigService } from "@nestjs/config";
import { EncryptionService } from "../common/crypto/encryption.service";
import { VehicleVerificationService } from "../vehicle-verification/vehicle-verification.service";
import { PaymentsService } from "../payments/payments.service";
import { PricingService } from "../payments/pricing.service";
import { PrismaService } from "../prisma/prisma.service";
import { BookingsService } from "./bookings.service";

jest.mock("bcryptjs", () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

const PRICING = {
  currency: "usd",
  days: 2,
  pricePerDay: 100,
  rentalSubtotal: 200,
  insurance: 20,
  commission: 20,
  total: 220,
  sena: 66,
  balance: 154,
  deposit: 200,
  ownerPayout: 180,
  rentalSubtotalMinor: 20000,
  insuranceMinor: 2000,
  commissionMinor: 2000,
  totalMinor: 22000,
  senaMinor: 6600,
  balanceMinor: 15400,
  depositMinor: 20000,
  ownerPayoutMinor: 18000,
};

/**
 * `expect.objectContaining` devuelve `any`, y meterlo adentro de otro objeto
 * deja a eslint marcando cada uso. Es el mismo matcher, con un tipo puesto.
 */
function contiene(esperado: Record<string, unknown>): unknown {
  return expect.objectContaining(esperado);
}

/** El último argumento con el que se llamó a un mock, ya tipado. */
function ultimoArgumento<T>(mock: jest.Mock): T {
  const llamadas = mock.mock.calls as T[][];
  const ultima = llamadas.at(-1);
  if (!ultima) throw new Error("el mock no se llamó ninguna vez");
  return ultima[0];
}

describe("BookingsService", () => {
  let service: BookingsService;
  let prisma: {
    listing: { findUnique: jest.Mock };
    booking: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
  let availability: {
    assertDateRange: jest.Mock;
    assertListingIsBookable: jest.Mock;
    calculateDays: jest.Mock;
  };
  let payments: {
    assertOwnerCanCollect: jest.Mock;
    assertReadyForPickup: jest.Mock;
    authorizeDepositForPickup: jest.Mock;
    cancelAndSettle: jest.Mock;
    previewCancellation: jest.Mock;
    settleBooking: jest.Mock;
    refundOnCancel: jest.Mock;
  };
  let pricing: { computeBooking: jest.Mock };
  let contracts: {
    createForBooking: jest.Mock;
    ensureForBooking: jest.Mock;
    accept: jest.Mock;
  };
  let email: Record<string, jest.Mock>;

  const listing = {
    id: "listing-1",
    vehicleId: "vehicle-1",
    ownerId: "owner-1",
    status: ListingStatus.ACTIVE,
    pricePerDay: 100,
    vehicle: { id: "vehicle-1" },
  };

  const booking = {
    id: "booking-1",
    listingId: "listing-1",
    vehicleId: "vehicle-1",
    ownerId: "owner-1",
    renterId: "renter-1",
    startDate: new Date("2099-01-01T00:00:00.000Z"),
    endDate: new Date("2099-01-03T00:00:00.000Z"),
    status: BookingStatus.REQUESTED,
    paymentStatus: PaymentStatus.PENDING,
    pricePerDaySnapshot: 100,
    pickupTokenHash: "pickup-hash",
    returnTokenHash: "return-hash",
  };

  beforeEach(async () => {
    prisma = {
      listing: { findUnique: jest.fn() },
      booking: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    availability = {
      assertDateRange: jest.fn(),
      assertListingIsBookable: jest.fn(),
      calculateDays: jest.fn().mockReturnValue(2),
    };
    payments = {
      // El dueño de las pruebas tiene Mercado Pago vinculado: lo que se
      // prueba acá es la reserva, no la vinculación.
      assertOwnerCanCollect: jest.fn().mockResolvedValue(undefined),
      assertReadyForPickup: jest.fn().mockResolvedValue(undefined),
      authorizeDepositForPickup: jest
        .fn()
        .mockResolvedValue({ authorized: true, requiresRenterAction: false }),
      cancelAndSettle: jest.fn().mockResolvedValue(null),
      previewCancellation: jest.fn(),
      settleBooking: jest.fn().mockResolvedValue({ settled: true }),
      refundOnCancel: jest.fn(),
    };
    pricing = { computeBooking: jest.fn().mockReturnValue(PRICING) };
    contracts = {
      createForBooking: jest.fn(),
      ensureForBooking: jest.fn(),
      accept: jest.fn(),
    };
    email = {
      sendBookingRequestedToOwner: jest.fn(),
      sendBookingRequestedToRenter: jest.fn(),
      sendBookingAcceptedToRenter: jest.fn(),
      sendBookingRejectedToRenter: jest.fn(),
      sendBookingCancelled: jest.fn(),
      sendPickupConfirmed: jest.fn(),
      sendReturnConfirmed: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AvailabilityService, useValue: availability },
        { provide: PaymentsService, useValue: payments },
        { provide: PricingService, useValue: pricing },
        { provide: ContractsService, useValue: contracts },
        { provide: AuditLogService, useValue: { create: jest.fn() } },
        { provide: EmailService, useValue: email },
        {
          provide: EncryptionService,
          useValue: {
            // En los tests el cifrado es identidad: lo que importa acá es que
            // el servicio lo use, no cómo cifra (eso se prueba aparte).
            encrypt: (v: string | null) => v,
            decrypt: (v: string | null) => v,
            tryDecrypt: (v: string | null) => v,
          },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: VehicleVerificationService,
          useValue: { assertVehicleVerified: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(BookingsService);
    (bcrypt.hash as jest.Mock).mockResolvedValue("token-hash");
  });

  it("creates a booking for an active listing", async () => {
    prisma.listing.findUnique.mockResolvedValue(listing);
    prisma.booking.create.mockResolvedValue(booking);

    const result = await service.create("renter-1", {
      listingId: listing.id,
      startDate: booking.startDate,
      endDate: booking.endDate,
    });

    // La respuesta es la reserva SIN los códigos de entrega y devolución:
    // con el de devolución a la vista, quien alquila podía confirmar sola que
    // devolvió el auto sin haberlo devuelto.
    expect(result).toMatchObject({ id: booking.id, status: booking.status });
    expect(result).not.toHaveProperty("pickupTokenHash");
    expect(result).not.toHaveProperty("returnTokenPreview");
    expect(availability.assertListingIsBookable).toHaveBeenCalledWith(
      listing.id,
      booking.startDate,
      booking.endDate,
    );
    expect(prisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: contiene({
          ownerId: listing.ownerId,
          renterId: "renter-1",
          totalPriceSnapshot: 200,
        }),
      }),
    );
  });

  it("rejects booking your own listing", async () => {
    prisma.listing.findUnique.mockResolvedValue(listing);

    await expect(
      service.create("owner-1", {
        listingId: listing.id,
        startDate: booking.startDate,
        endDate: booking.endDate,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects overlapping bookings", async () => {
    prisma.listing.findUnique.mockResolvedValue(listing);
    availability.assertListingIsBookable.mockRejectedValue(
      new BadRequestException(),
    );

    await expect(
      service.create("renter-1", {
        listingId: listing.id,
        startDate: booking.startDate,
        endDate: booking.endDate,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts, prices the booking, generates tokens and locks the contract", async () => {
    prisma.booking.findUnique.mockResolvedValue(booking);
    prisma.booking.update.mockResolvedValue({
      ...booking,
      status: BookingStatus.ACCEPTED,
    });

    const result = await service.accept("owner-1", booking.id);

    // Al dueño se le devuelve SOLO el código de devolución: el de entrega es
    // de quien alquila, y dárselo al dueño le permitiría confirmar solo una
    // entrega que no hizo.
    expect(result.returnQrToken).toBeDefined();
    expect(result).not.toHaveProperty("pickupQrToken");
    expect(result).not.toHaveProperty("pickupTokenPreview");
    expect(result).not.toHaveProperty("returnTokenPreview");
    expect(pricing.computeBooking).toHaveBeenCalledWith({
      pricePerDay: 100,
      days: 2,
    });
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: contiene({
          senaAmountSnapshot: PRICING.sena,
          // Ya no hay saldo aparte: el pago es uno solo.
          balanceAmountSnapshot: null,
          depositSnapshot: PRICING.deposit,
          ownerPayoutSnapshot: PRICING.ownerPayout,
          transferGroup: `booking_${booking.id}`,
        }),
      }),
    );
    expect(contracts.ensureForBooking).toHaveBeenCalledWith(booking.id);
    // Aceptar la reserva ES aceptar el contrato para el dueño, y queda
    // registrado con su IP (la prueba de la firma electrónica).
    expect(contracts.accept).toHaveBeenCalledWith("owner-1", booking.id, {});
  });

  it("rejects ready for pickup when payment is not settled", async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.ACCEPTED,
    });
    // La reserva sin pagar ni siquiera llega a intentar autorizar el depósito.
    await expect(
      service.readyForPickup("owner-1", booking.id),
    ).rejects.toMatchObject({ response: { code: "CHECKOUT_NOT_PAID" } });
    expect(payments.authorizeDepositForPickup).not.toHaveBeenCalled();
  });

  it("no deja marcar listo si el banco no autorizó el depósito solo", async () => {
    // El caso real: una tarjeta que pide autenticación. No es un error del
    // sistema; quien alquila tiene que autorizarla desde la app.
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.ACCEPTED,
      paymentStatus: PaymentStatus.FULLY_PAID,
    });
    payments.authorizeDepositForPickup.mockResolvedValue({
      authorized: false,
      requiresRenterAction: true,
    });

    await expect(
      service.readyForPickup("owner-1", booking.id),
    ).rejects.toMatchObject({
      response: { code: "DEPOSIT_AUTHORIZATION_REQUIRED" },
    });
  });

  it("marks ready for pickup once payment is settled", async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.ACCEPTED,
      paymentStatus: PaymentStatus.FULLY_PAID,
    });
    prisma.booking.update.mockResolvedValue({
      ...booking,
      status: BookingStatus.READY_FOR_PICKUP,
    });

    const result = await service.readyForPickup("owner-1", booking.id);

    expect(payments.authorizeDepositForPickup).toHaveBeenCalledWith(
      booking.id,
      "owner-1",
    );
    expect(payments.assertReadyForPickup).toHaveBeenCalledWith(booking.id);
    expect(result.status).toBe(BookingStatus.READY_FOR_PICKUP);
  });

  it("confirms pickup with correct token", async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.READY_FOR_PICKUP,
    });
    prisma.booking.update.mockResolvedValue({
      ...booking,
      status: BookingStatus.IN_PROGRESS,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await service.confirmPickup("owner-1", booking.id, "token");

    expect(result.status).toBe(BookingStatus.IN_PROGRESS);
  });

  it("rejects pickup before ready status", async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.ACCEPTED,
    });

    await expect(
      service.confirmPickup("owner-1", booking.id, "token"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects wrong return token", async () => {
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.IN_PROGRESS,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(
      service.confirmReturn("renter-1", booking.id, "bad-token"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("la devolución abre la ventana de inspección, no cierra la reserva", async () => {
    // Devuelto no es cerrado: el dueño tiene 48 horas para reportar un daño.
    // Antes la devolución liquidaba todo en el acto y el dueño que encontraba
    // un golpe al revisar el auto ya no tenía de dónde cobrarlo.
    prisma.booking.findUnique.mockResolvedValue({
      ...booking,
      status: BookingStatus.IN_PROGRESS,
    });
    prisma.booking.update.mockResolvedValue({
      ...booking,
      status: BookingStatus.INSPECTION,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await service.confirmReturn("renter-1", booking.id, "token");

    expect(result.status).toBe(BookingStatus.INSPECTION);
    expect(payments.settleBooking).not.toHaveBeenCalled();
    const data = ultimoArgumento<{
      data: { inspectionEndsAt: Date; status: BookingStatus };
    }>(prisma.booking.update).data;
    expect(data.status).toBe(BookingStatus.INSPECTION);
    expect(data.inspectionEndsAt).toBeInstanceOf(Date);
  });
  /**
   * LOS AVISOS POR MAIL
   *
   * Un alquiler entre dos personas que no se conocen se sostiene con que las dos
   * sepan por escrito qué pasó. Lo que se prueba acá no es el texto del mail (eso
   * vive en EmailService) sino QUIÉN recibe cada aviso: antes solo se le avisaba
   * al dueño cuando alguien pedía una reserva, y quien reservaba no recibía nada.
   */
  describe("avisos por mail", () => {
    const conPartes = {
      ...booking,
      owner: { id: "owner-1", email: "dueño@test.com", firstName: "Ana" },
      renter: {
        id: "renter-1",
        email: "inquilino@test.com",
        firstName: "Beto",
      },
      vehicle: { brand: "Toyota", model: "Corolla", year: 2021 },
      currency: "usd",
      totalPriceSnapshot: 200,
    };

    it("al pedir una reserva se avisa a las DOS partes", async () => {
      prisma.listing.findUnique.mockResolvedValue(listing);
      prisma.booking.create.mockResolvedValue(conPartes);

      await service.create("renter-1", {
        listingId: listing.id,
        startDate: booking.startDate,
        endDate: booking.endDate,
      });

      expect(email.sendBookingRequestedToOwner).toHaveBeenCalledWith(
        "dueño@test.com",
        expect.objectContaining({ renterName: "Beto", totalPrice: 200 }),
      );
      // Éste es el que faltaba.
      expect(email.sendBookingRequestedToRenter).toHaveBeenCalledWith(
        "inquilino@test.com",
        expect.objectContaining({ ownerName: "Ana", totalPrice: 200 }),
      );
    });

    it("si el mail falla, la reserva se crea igual", async () => {
      prisma.listing.findUnique.mockResolvedValue(listing);
      prisma.booking.create.mockResolvedValue(conPartes);
      email.sendBookingRequestedToRenter.mockRejectedValue(
        new Error("gmail caído"),
      );

      const result = await service.create("renter-1", {
        listingId: listing.id,
        startDate: booking.startDate,
        endDate: booking.endDate,
      });

      expect(result).toMatchObject({ id: conPartes.id });
    });

    it("una cancelación le llega a las dos partes, y cada una sabe si canceló ella", async () => {
      prisma.booking.findUnique.mockResolvedValue(conPartes);
      prisma.booking.update.mockResolvedValue({
        ...conPartes,
        status: BookingStatus.CANCELLED_BY_RENTER,
        cancellationReason: "Me surgió un viaje",
      });

      await service.cancel("renter-1", booking.id, {
        reason: "Me surgió un viaje",
      });

      // Al que canceló: "cancelaste". A la otra parte: "fue cancelada".
      expect(email.sendBookingCancelled).toHaveBeenCalledWith(
        "inquilino@test.com",
        expect.objectContaining({ cancelaste: true, otherPartyName: "Ana" }),
      );
      expect(email.sendBookingCancelled).toHaveBeenCalledWith(
        "dueño@test.com",
        expect.objectContaining({ cancelaste: false, otherPartyName: "Beto" }),
      );
      // Y el motivo viaja: es lo único que explica por qué se cayó el alquiler.
      const [, params] = email.sendBookingCancelled.mock.calls[0] as [
        string,
        { reason?: string | null; refunded?: boolean },
      ];
      expect(params.reason).toBe("Me surgió un viaje");
      // Sin pagos hechos, no se promete ninguna devolución.
      expect(params.refunded).toBe(false);
    });

    it("cuando había plata pagada, el mail avisa que se devuelve", async () => {
      prisma.booking.findUnique.mockResolvedValue({
        ...conPartes,
        status: BookingStatus.ACCEPTED,
        paymentStatus: PaymentStatus.FULLY_PAID,
      });
      prisma.booking.update.mockResolvedValue({
        ...conPartes,
        status: BookingStatus.CANCELLED_BY_OWNER,
      });

      // El reparto devuelve lo que corresponde según la política; el mail
      // avisa "se devuelve" solo si de verdad vuelve plata.
      payments.cancelAndSettle.mockResolvedValue({
        rule: "OWNER_RETURNS_SENA_DOUBLED",
        refundToRenterMinor: 33000,
        ownerReceivesMinor: 0,
        platformReceivesMinor: 0,
        ownerPenaltyMinor: 9000,
        explanation: "",
      });

      await service.cancel("owner-1", booking.id, { reason: "Se me rompió" });

      const [, params] = email.sendBookingCancelled.mock.calls[0] as [
        string,
        { refunded?: boolean },
      ];
      expect(params.refunded).toBe(true);
      expect(payments.cancelAndSettle).toHaveBeenCalled();
    });

    it("la entrega confirmada le llega a las dos partes, con el rol de cada una", async () => {
      prisma.booking.findUnique.mockResolvedValue({
        ...conPartes,
        status: BookingStatus.READY_FOR_PICKUP,
      });
      prisma.booking.update.mockResolvedValue({
        ...conPartes,
        status: BookingStatus.IN_PROGRESS,
        pickupConfirmedAt: new Date("2099-01-01T10:00:00.000Z"),
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.confirmPickup("owner-1", booking.id, "token");

      expect(email.sendPickupConfirmed).toHaveBeenCalledWith(
        "dueño@test.com",
        expect.objectContaining({ esDueño: true }),
      );
      expect(email.sendPickupConfirmed).toHaveBeenCalledWith(
        "inquilino@test.com",
        expect.objectContaining({ esDueño: false }),
      );
    });

    it("la devolución cierra la reserva y las dos partes reciben el aviso", async () => {
      prisma.booking.findUnique.mockResolvedValue({
        ...conPartes,
        status: BookingStatus.IN_PROGRESS,
      });
      prisma.booking.update.mockResolvedValue({
        ...conPartes,
        status: BookingStatus.COMPLETED,
        returnConfirmedAt: new Date("2099-01-03T10:00:00.000Z"),
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.confirmReturn("renter-1", booking.id, "token");

      expect(email.sendReturnConfirmed).toHaveBeenCalledWith(
        "dueño@test.com",
        expect.objectContaining({ esDueño: true, otherPartyName: "Beto" }),
      );
      expect(email.sendReturnConfirmed).toHaveBeenCalledWith(
        "inquilino@test.com",
        expect.objectContaining({ esDueño: false, otherPartyName: "Ana" }),
      );
    });

    it("no intenta mandar nada si la persona no tiene email cargado", async () => {
      prisma.listing.findUnique.mockResolvedValue(listing);
      prisma.booking.create.mockResolvedValue({
        ...conPartes,
        owner: { id: "owner-1", email: null, firstName: "Ana" },
      });

      await service.create("renter-1", {
        listingId: listing.id,
        startDate: booking.startDate,
        endDate: booking.endDate,
      });

      expect(email.sendBookingRequestedToOwner).not.toHaveBeenCalled();
      expect(email.sendBookingRequestedToRenter).toHaveBeenCalled();
    });
  });
});
