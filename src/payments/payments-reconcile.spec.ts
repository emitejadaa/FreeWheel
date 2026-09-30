import { ConfigService } from "@nestjs/config";
import { PaymentRecordKind, PaymentRecordStatus } from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import type {
  PaymentIntentResult,
  PaymentProvider,
} from "./providers/payment-provider.interface";
import { PaymentsService } from "./payments.service";

/**
 * Lo que la demo necesita para no depender de que el webhook ande:
 *
 *  1. que la consulta de estado le pregunte a Stripe por los cobros que el
 *     webhook todavía no contó, y los pase por los mismos manejadores;
 *  2. que un éxito se aplique UNA sola vez aunque llegue por los dos caminos;
 *  3. que el front reciba la clave pública de la misma cuenta que el backend.
 */

type Handlers = {
  onIntentSucceeded: jest.Mock;
  onHoldAuthorized: jest.Mock;
  onIntentProcessing: jest.Mock;
  onIntentFailed: jest.Mock;
  onIntentCanceled: jest.Mock;
};

function intent(
  status: string,
  extra: Partial<PaymentIntentResult> = {},
): PaymentIntentResult {
  return {
    id: "pi_test_1",
    clientSecret: null,
    status,
    amountMinor: 1000,
    currency: "usd",
    ...extra,
  };
}

function record(
  kind: PaymentRecordKind,
  status: PaymentRecordStatus = PaymentRecordStatus.REQUIRES_ACTION,
  stripePaymentIntentId = "pi_test_1",
) {
  return {
    id: `rec_${kind}`,
    bookingId: "b1",
    kind,
    status,
    stripePaymentIntentId,
  };
}

function armar(opts: {
  providerName?: string;
  records?: unknown[];
  retrieve?: jest.Mock;
  config?: Record<string, string>;
}) {
  const prisma = {
    paymentRecord: {
      findMany: jest.fn().mockResolvedValue(opts.records ?? []),
    },
  };
  const provider = {
    name: opts.providerName ?? "stripe",
    retrieveIntent: opts.retrieve ?? jest.fn(),
  };
  const config = opts.config ?? {};
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    provider as unknown as PaymentProvider,
    { create: jest.fn() } as unknown as AuditLogService,
    { get: (k: string) => config[k] } as unknown as ConfigService,
    {} as unknown as EmailService,
    {} as never,
    {} as never,
  );
  const handlers = service as unknown as Handlers & {
    reconcilePending: (bookingId: string) => Promise<void>;
  };
  for (const name of [
    "onIntentSucceeded",
    "onHoldAuthorized",
    "onIntentProcessing",
    "onIntentFailed",
    "onIntentCanceled",
  ] as const) {
    handlers[name] = jest.fn().mockResolvedValue(undefined);
  }
  return {
    service,
    prisma,
    provider,
    handlers,
    reconcile: (id = "b1") => handlers.reconcilePending(id),
  };
}

describe("PaymentsService: conciliar con Stripe al consultar el estado", () => {
  it("con el provider de simulación no consulta nada", async () => {
    const { reconcile, prisma, provider } = armar({ providerName: "mock" });

    await reconcile();

    expect(prisma.paymentRecord.findMany).not.toHaveBeenCalled();
    expect(provider.retrieveIntent).not.toHaveBeenCalled();
  });

  it("busca solo los cobros que esperan confirmación, de esa reserva", async () => {
    const { reconcile, prisma } = armar({});

    await reconcile("reserva-7");

    expect(prisma.paymentRecord.findMany).toHaveBeenCalledWith({
      where: {
        bookingId: "reserva-7",
        stripePaymentIntentId: { not: null },
        status: {
          in: [
            PaymentRecordStatus.REQUIRES_ACTION,
            PaymentRecordStatus.PROCESSING,
          ],
        },
      },
    });
  });

  it("un cobro que Stripe ya dio por hecho se aplica como si llegara el webhook", async () => {
    const { reconcile, handlers } = armar({
      records: [record(PaymentRecordKind.CHECKOUT)],
      retrieve: jest.fn().mockResolvedValue(intent("succeeded")),
    });

    await reconcile();

    expect(handlers.onIntentSucceeded).toHaveBeenCalledWith("pi_test_1");
  });

  it("una retención autorizada se aplica como retención, con lo que Stripe contestó", async () => {
    const hold = intent("requires_capture", { amountCapturableMinor: 500 });
    const { reconcile, handlers } = armar({
      records: [record(PaymentRecordKind.DEPOSIT_HOLD)],
      retrieve: jest.fn().mockResolvedValue(hold),
    });

    await reconcile();

    expect(handlers.onHoldAuthorized).toHaveBeenCalledWith(
      "pi_test_1",
      undefined,
      hold,
    );
    expect(handlers.onIntentSucceeded).not.toHaveBeenCalled();
  });

  it("un rechazo con error se anota; un intent sin intentar, no", async () => {
    const rechazado = armar({
      records: [record(PaymentRecordKind.CHECKOUT)],
      retrieve: jest.fn().mockResolvedValue(
        intent("requires_payment_method", {
          failure: {
            code: "card_declined",
            message: "Your card was declined.",
          },
        }),
      ),
    });
    await rechazado.reconcile();
    expect(rechazado.handlers.onIntentFailed).toHaveBeenCalledWith("pi_test_1");

    const virgen = armar({
      records: [record(PaymentRecordKind.CHECKOUT)],
      retrieve: jest
        .fn()
        .mockResolvedValue(
          intent("requires_payment_method", { failure: null }),
        ),
    });
    await virgen.reconcile();
    expect(virgen.handlers.onIntentFailed).not.toHaveBeenCalled();
  });

  it("en medio de 3-D Secure no aplica nada", async () => {
    const { reconcile, handlers } = armar({
      records: [record(PaymentRecordKind.CHECKOUT)],
      retrieve: jest.fn().mockResolvedValue(intent("requires_action")),
    });

    await reconcile();

    for (const handler of Object.values(handlers)) {
      if (jest.isMockFunction(handler)) expect(handler).not.toHaveBeenCalled();
    }
  });

  it("processing se anota una vez, cancelado se anota", async () => {
    const enCurso = armar({
      records: [
        record(PaymentRecordKind.CHECKOUT, PaymentRecordStatus.PROCESSING),
      ],
      retrieve: jest.fn().mockResolvedValue(intent("processing")),
    });
    await enCurso.reconcile();
    expect(enCurso.handlers.onIntentProcessing).not.toHaveBeenCalled();

    const cancelado = armar({
      records: [record(PaymentRecordKind.CHECKOUT)],
      retrieve: jest.fn().mockResolvedValue(intent("canceled")),
    });
    await cancelado.reconcile();
    expect(cancelado.handlers.onIntentCanceled).toHaveBeenCalledWith(
      "pi_test_1",
    );
  });

  it("un identificador de la simulación no se le pregunta a Stripe", async () => {
    const retrieve = jest.fn();
    const { reconcile } = armar({
      records: [
        record(
          PaymentRecordKind.CHECKOUT,
          PaymentRecordStatus.REQUIRES_ACTION,
          "pi_mock_viejo",
        ),
      ],
      retrieve,
    });

    await reconcile();

    expect(retrieve).not.toHaveBeenCalled();
  });

  it("si Stripe no contesta o un manejador falla, la consulta no se cae", async () => {
    const caido = armar({
      records: [record(PaymentRecordKind.CHECKOUT)],
      retrieve: jest.fn().mockRejectedValue(new Error("stripe caído")),
    });
    await expect(caido.reconcile()).resolves.toBeUndefined();
    expect(caido.handlers.onIntentSucceeded).not.toHaveBeenCalled();

    const roto = armar({
      records: [record(PaymentRecordKind.CHECKOUT)],
      retrieve: jest.fn().mockResolvedValue(intent("succeeded")),
    });
    roto.handlers.onIntentSucceeded.mockRejectedValue(new Error("db"));
    await expect(roto.reconcile()).resolves.toBeUndefined();
  });
});

describe("PaymentsService: un éxito se aplica una sola vez", () => {
  it("si otro camino ya lo aplicó, no anota, no asienta y no avisa", async () => {
    const tx = {
      paymentRecord: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: jest.fn(),
      },
      booking: { update: jest.fn() },
    };
    const prisma = {
      paymentRecord: {
        findUnique: jest.fn().mockResolvedValue({
          id: "rec_1",
          bookingId: "b1",
          kind: PaymentRecordKind.CHECKOUT,
          status: PaymentRecordStatus.CAPTURED,
          amountMinor: 1000,
          amount: 10,
          currency: "usd",
        }),
      },
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      paymentEvent: { create: jest.fn() },
      ledgerEntry: { findFirst: jest.fn() },
    };
    const audit = { create: jest.fn() };
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      {
        name: "stripe",
        retrieveIntent: jest.fn().mockResolvedValue(intent("succeeded")),
      } as unknown as PaymentProvider,
      audit as unknown as AuditLogService,
      { get: () => undefined } as unknown as ConfigService,
      {} as unknown as EmailService,
      {} as never,
      {} as never,
    );
    const avisar = jest.fn();
    const ensureFunds = jest.fn();
    Object.assign(service, {
      avisarDelPago: avisar,
      ensureFundsJournal: ensureFunds,
    });

    await (
      service as unknown as {
        onIntentSucceeded: (id: string, ev?: string) => Promise<void>;
      }
    ).onIntentSucceeded("pi_test_1", "evt_1");

    // El candado: la escritura solo toca la fila si todavía está en un estado
    // aplicable, y CAPTURED no lo es.
    const [args] = tx.paymentRecord.updateMany.mock.calls[0] as [
      { where: { id: string; status: { in: PaymentRecordStatus[] } } },
    ];
    expect(args.where.id).toBe("rec_1");
    expect(args.where.status.in).not.toContain(PaymentRecordStatus.CAPTURED);
    expect(args.where.status.in).toContain(PaymentRecordStatus.REQUIRES_ACTION);
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(ensureFunds).not.toHaveBeenCalled();
    expect(prisma.paymentEvent.create).not.toHaveBeenCalled();
    expect(audit.create).not.toHaveBeenCalled();
    expect(avisar).not.toHaveBeenCalled();
  });
});

describe("PaymentsService: la configuración pública de pagos", () => {
  it("con Stripe entrega la clave pública de prueba y la moneda en minúsculas", () => {
    const { service } = armar({
      config: {
        STRIPE_PUBLISHABLE_KEY: " pk_test_abc123 ",
        STRIPE_SECRET_KEY: "sk_test_x",
        DEFAULT_CURRENCY: "USD",
      },
    });

    expect(service.publicConfig()).toEqual({
      provider: "stripe",
      publishableKey: "pk_test_abc123",
      currency: "usd",
      testMode: true,
    });
  });

  it("una clave pública de producción no se entrega", () => {
    const { service } = armar({
      config: { STRIPE_PUBLISHABLE_KEY: "pk_live_abc" },
    });

    expect(service.publicConfig().publishableKey).toBeNull();
  });

  it("sin Stripe no hay clave, y la moneda cae en usd", () => {
    const { service } = armar({
      providerName: "unconfigured",
      config: { STRIPE_PUBLISHABLE_KEY: "pk_test_abc" },
    });

    expect(service.publicConfig()).toEqual({
      provider: "unconfigured",
      publishableKey: null,
      currency: "usd",
      testMode: true,
    });
  });
});
