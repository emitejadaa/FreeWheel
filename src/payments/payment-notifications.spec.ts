import { ConfigService } from "@nestjs/config";
import { PaymentRecordKind } from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import type { PaymentProvider } from "./providers/payment-provider.interface";
import { PaymentsService } from "./payments.service";

/**
 * Los avisos de un pago.
 *
 * Van enganchados en onIntentSucceeded, que es el ÚNICO lugar por donde pasan los
 * dos caminos de cobro: el webhook de Stripe y el pago simulado del modo mock.
 * Lo que se prueba acá son las tres decisiones que se tomaron ahí:
 *
 *  1. que el concepto se muestre en castellano y no como código interno;
 *  2. que el DEPÓSITO EN GARANTÍA no le avise al dueño que "recibió un pago",
 *     porque es una retención y no plata que él cobre;
 *  3. que un mail que falla no revierta un cobro que ya se hizo.
 */
describe("PaymentsService: avisos de un pago", () => {
  const RESERVA = {
    id: "3f9a1b2c-0000-0000-0000-000000000000",
    currency: "ARS",
    startDate: new Date("2026-09-10T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
    owner: { email: "dueño@test.com", firstName: "Ana", lastName: "Ruiz" },
    renter: { email: "inquilino@test.com", firstName: "Beto", lastName: "Paz" },
    vehicle: { brand: "Toyota", model: "Corolla", year: 2021 },
  };

  function armar(reserva: unknown = RESERVA) {
    const email = {
      sendPaymentReceipt: jest.fn(),
      sendPaymentReceivedToOwner: jest.fn(),
    };
    const prisma = {
      booking: { findUnique: jest.fn().mockResolvedValue(reserva) },
      paymentRecord: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 14400 } }),
      },
    };
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      { name: "mock" } as unknown as PaymentProvider,
      { create: jest.fn() } as unknown as AuditLogService,
      { get: () => undefined } as unknown as ConfigService,
      email as unknown as EmailService,
    );
    // El aviso es interno a propósito: se dispara desde onIntentSucceeded y no es
    // parte de la API del servicio. Se lo llama directo para probarlo aislado.
    const avisar = (kind: PaymentRecordKind | null, amount: number | null) =>
      (
        service as unknown as {
          avisarDelPago: (
            id: string,
            k: PaymentRecordKind | null,
            a: number | null,
          ) => Promise<void>;
        }
      ).avisarDelPago(RESERVA.id, kind, amount);

    return { avisar, email, prisma };
  }

  it("la seña genera comprobante al inquilino y aviso al dueño", async () => {
    const { avisar, email } = armar();

    await avisar(PaymentRecordKind.SENA, 14400);

    expect(email.sendPaymentReceipt).toHaveBeenCalledWith(
      "inquilino@test.com",
      expect.objectContaining({
        concepto: "Seña",
        amount: 14400,
        currency: "ARS",
        vehicleLabel: "Toyota Corolla 2021",
        renterName: "Beto Paz",
        totalPaid: 14400,
      }),
    );
    expect(email.sendPaymentReceivedToOwner).toHaveBeenCalledWith(
      "dueño@test.com",
      expect.objectContaining({
        concepto: "Seña",
        renterName: "Beto Paz",
        ownerName: "Ana Ruiz",
      }),
    );
  });

  it("el saldo se llama Saldo, no BALANCE", async () => {
    const { avisar, email } = armar();

    await avisar(PaymentRecordKind.BALANCE, 33600);

    const [, params] = email.sendPaymentReceipt.mock.calls[0] as [
      string,
      { concepto: string },
    ];
    expect(params.concepto).toBe("Saldo");
  });

  it("el depósito en garantía NO le avisa al dueño que recibió un pago", async () => {
    const { avisar, email } = armar();

    await avisar(PaymentRecordKind.DEPOSIT_HOLD, 200);

    // Al inquilino sí: le retuvieron plata y tiene que quedar constancia.
    expect(email.sendPaymentReceipt).toHaveBeenCalledWith(
      "inquilino@test.com",
      expect.objectContaining({ concepto: "Depósito en garantía" }),
    );
    // Al dueño no: esa plata no es suya.
    expect(email.sendPaymentReceivedToOwner).not.toHaveBeenCalled();
  });

  it("un mail que falla no propaga el error al cobro", async () => {
    const { avisar, email } = armar();
    email.sendPaymentReceipt.mockRejectedValue(new Error("gmail caído"));

    await expect(
      avisar(PaymentRecordKind.SENA, 14400),
    ).resolves.toBeUndefined();
  });

  it("sin concepto o sin importe no manda nada", async () => {
    const { avisar, email, prisma } = armar();

    await avisar(null, 14400);
    await avisar(PaymentRecordKind.SENA, null);

    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(email.sendPaymentReceipt).not.toHaveBeenCalled();
  });

  it("si la reserva ya no existe, no se cae", async () => {
    const { avisar, email } = armar(null);

    await expect(
      avisar(PaymentRecordKind.SENA, 14400),
    ).resolves.toBeUndefined();
    expect(email.sendPaymentReceipt).not.toHaveBeenCalled();
  });

  it("sin email cargado no intenta mandar a esa persona", async () => {
    const { avisar, email } = armar({
      ...RESERVA,
      owner: { email: null, firstName: "Ana" },
    });

    await avisar(PaymentRecordKind.SENA, 14400);

    expect(email.sendPaymentReceipt).toHaveBeenCalled();
    expect(email.sendPaymentReceivedToOwner).not.toHaveBeenCalled();
  });
});
