import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { AvailabilityService } from "../availability/availability.service";
import { AuditLogService } from "../common/services/audit-log.service";
import { EncryptionService } from "../common/crypto/encryption.service";
import { ContractsService } from "../contracts/contracts.service";
import { EmailService } from "../email/email.service";
import { PaymentsService } from "../payments/payments.service";
import { PricingService } from "../payments/pricing.service";
import { PrismaService } from "../prisma/prisma.service";
import { VehicleVerificationService } from "../vehicle-verification/vehicle-verification.service";
import { BookingsService } from "./bookings.service";

/**
 * EL RETIRO QUE NO PASÓ, DESDE EL SERVICIO
 *
 * La decisión de plata vive en cancellation-policy.ts y se prueba ahí, con
 * fechas a mano y sin base. Esto prueba la otra mitad: que las constancias se
 * puedan dejar, quién puede dejar cuál, y qué queda escrito cuando las dos
 * existen.
 *
 * Lo que se cuida acá, en una frase: que las dos partes tengan exactamente las
 * mismas herramientas. Durante un tiempo solo el dueño pudo dejar constancia, y
 * eso no era una asimetría de código sino de poder: su versión era la única
 * escrita que existía, y alcanzaba con reportar para quedarse con la seña.
 */
describe("Las dos constancias del retiro", () => {
  let service: BookingsService;
  let prisma: {
    booking: { findUnique: jest.Mock; update: jest.Mock; findMany: jest.Mock };
  };
  let auditLog: { create: jest.Mock };

  const INICIO = new Date("2026-06-10T15:00:00.000Z");
  /** Cinco horas después del horario acordado: dentro de la ventana. */
  const DENTRO_DE_LA_VENTANA = new Date("2026-06-10T20:00:00.000Z");

  /**
   * La fila de la reserva, con los tipos ANCHOS a propósito.
   *
   * Sin esta anotación TypeScript infiere `null` y `"READY_FOR_PICKUP"` como
   * tipos literales, y las pruebas que necesitan una fila con otra hora o en
   * otro estado no compilan.
   */
  interface ReservaDePrueba {
    id: string;
    listingId: string;
    vehicleId: string;
    ownerId: string;
    renterId: string;
    startDate: Date;
    endDate: Date;
    status: BookingStatus;
    paymentStatus: PaymentStatus;
    pricePerDaySnapshot: number;
    pickupConfirmedAt: Date | null;
    renterNoShowAt: Date | null;
    ownerNoShowAt: Date | null;
    noShowResolvedFor: string | null;
  }

  const reserva: ReservaDePrueba = {
    id: "booking-1",
    listingId: "listing-1",
    vehicleId: "vehicle-1",
    ownerId: "owner-1",
    renterId: "renter-1",
    startDate: INICIO,
    endDate: new Date("2026-06-12T15:00:00.000Z"),
    status: BookingStatus.READY_FOR_PICKUP,
    paymentStatus: PaymentStatus.FULLY_PAID,
    pricePerDaySnapshot: 100,
    pickupConfirmedAt: null,
    renterNoShowAt: null,
    ownerNoShowAt: null,
    noShowResolvedFor: null,
  };

  /*
    La fila como está en la base. Se guarda en una variable y no se devuelve
    una constante porque el servicio LEE la reserva y DESPUÉS mira el resultado
    del update para saber si quedaron las dos constancias. Con un update que
    devolviera siempre la fila original, el caso trabado no se detectaría nunca
    en la prueba aunque el código lo detecte bien.
  */
  let enLaBase: ReservaDePrueba;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(DENTRO_DE_LA_VENTANA);
    enLaBase = { ...reserva };
    prisma = {
      booking: {
        findUnique: jest.fn().mockImplementation(() => enLaBase),
        update: jest.fn().mockImplementation(
          ({ data }: { data: Partial<ReservaDePrueba> }): ReservaDePrueba => ({
            ...enLaBase,
            ...data,
          }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    auditLog = { create: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AvailabilityService, useValue: {} },
        { provide: PaymentsService, useValue: {} },
        { provide: PricingService, useValue: {} },
        { provide: ContractsService, useValue: {} },
        { provide: AuditLogService, useValue: auditLog },
        { provide: EmailService, useValue: {} },
        {
          provide: EncryptionService,
          useValue: {
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
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** El primer argumento de cada llamada a un mock, ya tipado. */
  function argumentos<T>(mock: jest.Mock): T[] {
    return (mock.mock.calls as unknown[][]).map((llamada) => llamada[0] as T);
  }

  /** Lo que se le pasó a prisma.booking.update en el último llamado. */
  const loGuardado = () =>
    argumentos<{ data: Record<string, unknown> }>(prisma.booking.update).at(-1)
      ?.data;

  interface LineaDeAuditoria {
    action: string;
    metadata?: Record<string, unknown>;
  }

  /** Las líneas que se anotaron en el registro de auditoría. */
  const anotaciones = () => argumentos<LineaDeAuditoria>(auditLog.create);
  const seAnoto = (action: string) =>
    anotaciones().some((linea) => linea.action === action);

  // ── Quién puede dejar cuál ──────────────────────────────────────────────

  it("el dueño deja constancia de que no fue quien alquiló", async () => {
    await service.reportRenterNoShow("owner-1", "booking-1");
    expect(loGuardado()).toEqual({ renterNoShowAt: DENTRO_DE_LA_VENTANA });
    expect(seAnoto("booking.renter_no_show_reported")).toBe(true);
  });

  it("y QUIEN ALQUILÓ deja la suya de que no fue el dueño", async () => {
    await service.reportOwnerNoShow("renter-1", "booking-1");
    expect(loGuardado()).toEqual({ ownerNoShowAt: DENTRO_DE_LA_VENTANA });
    expect(seAnoto("booking.owner_no_show_reported")).toBe(true);
  });

  it("NINGUNO PUEDE USAR LA PUERTA DEL OTRO", async () => {
    /*
      Sin esto, el dueño podría dejar la constancia de que él mismo no apareció
      —o, peor, crear la disputa solo— y quien alquiló podría firmar la
      acusación que le correspondía al dueño. Cada constancia dice algo sobre
      QUIEN LA FIRMA, así que tiene que firmarla su dueño.
    */
    await expect(
      service.reportOwnerNoShow("owner-1", "booking-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.reportRenterNoShow("renter-1", "booking-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  it("un tercero tampoco", async () => {
    await expect(
      service.reportOwnerNoShow("un-desconocido", "booking-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── Cuándo ──────────────────────────────────────────────────────────────

  it("antes de la gracia no se puede, de ninguno de los dos lados", async () => {
    jest.setSystemTime(new Date(INICIO.getTime() + 10 * 60 * 1000));
    await expect(
      service.reportOwnerNoShow("renter-1", "booking-1"),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.reportRenterNoShow("owner-1", "booking-1"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("con la entrega ya confirmada no hay nada que reportar", async () => {
    enLaBase = {
      ...reserva,
      pickupConfirmedAt: new Date(),
      status: BookingStatus.IN_PROGRESS,
    };
    await expect(
      service.reportOwnerNoShow("renter-1", "booking-1"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("reportar dos veces no es un error: es el mismo hecho", async () => {
    // Y la hora que vale es la del primer reporte, no la del segundo toque.
    enLaBase = {
      ...reserva,
      ownerNoShowAt: new Date("2026-06-10T18:00:00.000Z"),
    };
    await service.reportOwnerNoShow("renter-1", "booking-1");
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  // ── Cuando quedan las dos ───────────────────────────────────────────────

  it("CON LAS DOS, EL CASO TRABADO QUEDA ANOTADO APARTE", async () => {
    /*
      Cada reporte ya deja su línea. El momento en que se traba es un hecho
      distinto —es el único en que la plata deja de moverse sola— y se anota
      por separado para que quien busque casos trabados no tenga que deducirlos
      cruzando dos líneas sueltas.
    */
    enLaBase = {
      ...reserva,
      renterNoShowAt: new Date("2026-06-10T19:00:00.000Z"),
    };
    await service.reportOwnerNoShow("renter-1", "booking-1");

    expect(seAnoto("booking.owner_no_show_reported")).toBe(true);
    expect(seAnoto("booking.no_show_disputed")).toBe(true);
    const trabado = anotaciones().find(
      (linea) => linea.action === "booking.no_show_disputed",
    );
    // Las DOS versiones con su hora: es lo que convierte el caso en algo que
    // alguien pueda resolver sin tener que ir a buscar nada.
    expect(trabado?.metadata?.elDuenoReportoA).toBe("2026-06-10T19:00:00.000Z");
    expect(trabado?.metadata?.quienAlquiloReportoA).toBe(
      DENTRO_DE_LA_VENTANA.toISOString(),
    );
  });

  it("con una sola constancia NO se anota ningún caso trabado", async () => {
    await service.reportOwnerNoShow("renter-1", "booking-1");
    expect(seAnoto("booking.no_show_disputed")).toBe(false);
  });

  // ── La tarea nocturna ───────────────────────────────────────────────────

  it("EL CIERRE AUTOMÁTICO NO TOCA LOS CASOS TRABADOS", async () => {
    /*
      Sin este filtro la tarea intentaría cerrarlos todas las noches, el
      servicio contestaría NO_SHOW_DISPUTED, y cada caso abierto escribiría un
      error por día en el log: ruido que tapa los errores de verdad, sobre algo
      que está funcionando como corresponde.
    */
    await service.cerrarRetirosQueNoPasaron(
      new Date("2026-06-12T15:00:00.000Z"),
    );
    const filtro = argumentos<{ where: { NOT?: Record<string, unknown> } }>(
      prisma.booking.findMany,
    ).at(-1);
    expect(filtro?.where.NOT).toEqual({
      renterNoShowAt: { not: null },
      ownerNoShowAt: { not: null },
      noShowResolvedFor: null,
    });
  });
});
