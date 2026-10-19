import { ConfigService } from "@nestjs/config";
import { StripeAccountStatus } from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { EmailService } from "../email/email.service";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "../ledger/ledger.service";
import { Accounts } from "../ledger/accounts";
import type { PaymentProvider } from "./providers/payment-provider.interface";
import { PaymentsService } from "./payments.service";
import {
  cuentaSimuladaDe,
  esIdentificadorSimulado,
  hayQueSimularLosCobros,
  transferenciaSimulada,
} from "./cobros-simulados";

/**
 * LA PLATA QUE VA AL DUEÑO, CUANDO SE SIMULA
 *
 * El contexto entero está en cobros-simulados.ts. En corto: el cobro con
 * tarjeta va a Stripe en modo de prueba, pero la transferencia AL DUEÑO
 * necesita Stripe Connect, que es un alta de plataforma que este deploy no
 * tiene. Antes eso se traducía en tres carteles de "todavía no podés cobrar"
 * sobre plata que nunca iba a moverse, y en una transferencia que fallaba al
 * cerrar cada alquiler.
 *
 * Lo que se prueba acá son las cuatro cosas que hacen que eso no pase:
 *
 *   1. que simular sea el valor por omisión, y que una sola variable alcance
 *      para volver al camino real;
 *   2. que el alta no mande a nadie a Stripe ni devuelva un enlace a ninguna
 *      parte;
 *   3. que el estado se conteste SIN tocar la base, porque es una consulta;
 *   4. que la liquidación le acredite la plata al dueño igual, sin llamar al
 *      procesador, y que un reintento no la pague dos veces.
 */
describe("Cobros simulados", () => {
  const DUEÑO = {
    id: "11111111-2222-3333-4444-555555555555",
    email: "dueño@test.com",
    firstName: "Ana",
    lastName: "Ruiz",
    stripeAccountId: null,
    stripeAccountStatus: StripeAccountStatus.NONE,
  };

  /** El servicio, con lo mínimo que esta parte toca. */
  function armar({ connectHabilitado = false } = {}) {
    const provider = {
      name: "stripe",
      createConnectedAccount: jest.fn(),
      getConnectedAccountStatus: jest.fn(),
      transferToOwner: jest.fn(),
    };
    const usuario = { ...DUEÑO };
    const prisma = {
      user: {
        findUnique: jest.fn().mockImplementation(() => usuario),
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(usuario, data);
          return usuario;
        }),
      },
      ledgerEntry: {
        findFirst: jest.fn().mockResolvedValue({ currency: "ARS" }),
      },
      paymentEvent: { create: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (fn: unknown) => {
        const tx = {
          paymentRecord: { create: jest.fn().mockResolvedValue({ id: "pr1" }) },
          booking: { update: jest.fn() },
          paymentEvent: { create: jest.fn() },
        };
        return (fn as (t: unknown) => Promise<unknown>)(tx);
      }),
    };
    const asientos: { idempotencyKey: string }[] = [];
    const ledger = {
      balance: jest.fn().mockResolvedValue(48000),
      post: jest
        .fn()
        .mockImplementation((asiento: { idempotencyKey: string }) => {
          if (
            asientos.some((a) => a.idempotencyKey === asiento.idempotencyKey)
          ) {
            throw new Error("asiento repetido");
          }
          asientos.push(asiento);
        }),
    };
    const config = {
      get: (clave: string) =>
        clave === "STRIPE_CONNECT_ENABLED" && connectHabilitado
          ? "true"
          : undefined,
    };
    const service = new PaymentsService(
      prisma as unknown as PrismaService,
      provider as unknown as PaymentProvider,
      { create: jest.fn() } as unknown as AuditLogService,
      config as unknown as ConfigService,
      {} as unknown as EmailService,
      ledger as unknown as LedgerService,
      {} as never,
    );
    return { service, provider, prisma, ledger, asientos, usuario };
  }

  // ── 1. La decisión ────────────────────────────────────────────────────

  describe("cuándo se simula", () => {
    const con = (valor: string | undefined) =>
      hayQueSimularLosCobros({
        get: () => valor,
      } as unknown as ConfigService);

    it("SIN LA VARIABLE SE SIMULA: el valor por omisión es el que no rompe", () => {
      expect(con(undefined)).toBe(true);
      expect(con("")).toBe(true);
    });

    it("y solo true o 1 vuelven al camino real", () => {
      expect(con("true")).toBe(false);
      expect(con("TRUE")).toBe(false);
      expect(con(" 1 ")).toBe(false);
      // Cualquier otra cosa —incluido un "false" mal tipeado— simula.
      expect(con("si")).toBe(true);
      expect(con("yes")).toBe(true);
      expect(con("false")).toBe(true);
    });
  });

  describe("los identificadores", () => {
    it("la cuenta de una persona es SIEMPRE LA MISMA", () => {
      expect(cuentaSimuladaDe(DUEÑO.id)).toBe(cuentaSimuladaDe(DUEÑO.id));
      expect(cuentaSimuladaDe(DUEÑO.id)).not.toBe(cuentaSimuladaDe("otro-id"));
      expect(esIdentificadorSimulado(cuentaSimuladaDe(DUEÑO.id))).toBe(true);
    });

    it("y la transferencia no se confunde con una de Stripe ni con una del mock", () => {
      const id = transferenciaSimulada(DUEÑO.id, "settle:abc", 48000);
      expect(esIdentificadorSimulado(id)).toBe(true);
      expect(esIdentificadorSimulado("tr_1Oabc")).toBe(false);
      expect(esIdentificadorSimulado("acct_mock_123")).toBe(false);
    });
  });

  // ── 2. El alta ────────────────────────────────────────────────────────

  describe("el alta del dueño", () => {
    it("NO LE PIDE NADA A STRIPE Y NO DEVUELVE NINGÚN ENLACE", async () => {
      const { service, provider } = armar();
      const alta = await service.createOwnerOnboarding(DUEÑO.id);

      expect(provider.createConnectedAccount).not.toHaveBeenCalled();
      // Sin enlace el front no dibuja el botón: no hay adónde mandar a nadie.
      expect(alta.onboardingUrl).toBeNull();
      expect(alta.simulated).toBe(true);
      expect(alta.accountId).toBe(cuentaSimuladaDe(DUEÑO.id));
    });

    it("y le deja la cuenta de cobro habilitada", async () => {
      const { service, usuario } = armar();
      await service.createOwnerOnboarding(DUEÑO.id);
      expect(usuario.stripeAccountId).toBe(cuentaSimuladaDe(DUEÑO.id));
      expect(usuario.stripeAccountStatus).toBe(StripeAccountStatus.ENABLED);
    });

    it("con Connect habilitado vuelve al camino de siempre", async () => {
      const { service, provider } = armar({ connectHabilitado: true });
      provider.createConnectedAccount.mockResolvedValue({
        accountId: "acct_1Real",
        onboardingUrl: "https://connect.stripe.com/setup/x",
      });
      const alta = await service.createOwnerOnboarding(DUEÑO.id);
      expect(provider.createConnectedAccount).toHaveBeenCalled();
      expect(alta.onboardingUrl).toBe("https://connect.stripe.com/setup/x");
    });
  });

  // ── 3. El estado ──────────────────────────────────────────────────────

  describe("el estado de cobro", () => {
    it("dice que está todo listo, Y QUE ESTÁ SIMULADO", async () => {
      const { service, provider } = armar();
      const estado = await service.getOwnerPayoutStatus(DUEÑO.id);

      expect(provider.getConnectedAccountStatus).not.toHaveBeenCalled();
      expect(estado).toMatchObject({
        connected: true,
        status: StripeAccountStatus.ENABLED,
        payoutsEnabled: true,
        detailsSubmitted: true,
        simulated: true,
      });
    });

    it("NO ESCRIBE EN LA BASE: es una consulta, y la abre el panel cada vez", async () => {
      const { service, prisma } = armar();
      await service.getOwnerPayoutStatus(DUEÑO.id);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ── 4. La liquidación ─────────────────────────────────────────────────

  describe("pagarle al dueño", () => {
    it("LE ACREDITA LA PLATA SIN LLAMAR AL PROCESADOR", async () => {
      const { service, provider, ledger, asientos } = armar();
      const pago = await service.payOwner(
        DUEÑO as never,
        "settle:reserva-1",
        null,
      );

      expect(provider.transferToOwner).not.toHaveBeenCalled();
      expect(pago).toEqual({ paidMinor: 48000, pending: false });
      // El asiento se escribe igual: el libro no distingue, y no tiene por qué.
      expect(ledger.post).toHaveBeenCalled();
      expect(asientos[0].idempotencyKey).toContain("_sim_");
      const lineas = (
        asientos[0] as unknown as {
          lines: { account: string; amountMinor: number }[];
        }
      ).lines;
      expect(lineas).toContainEqual({
        account: Accounts.ownerPayable(DUEÑO.id),
        amountMinor: -48000,
      });
    });

    it("Y UN REINTENTO NO LE PAGA DOS VECES", async () => {
      /*
        Es lo que protege el identificador determinístico. El cron reintenta
        las liquidaciones que quedaron debiendo; si cada intento inventara un
        identificador nuevo, cada corrida sería un pago más.
      */
      const { service, ledger } = armar();
      await service.payOwner(DUEÑO as never, "settle:reserva-1", null);
      const segundo = await service.payOwner(
        DUEÑO as never,
        "settle:reserva-1",
        null,
      );

      // El segundo intento choca contra la clave del asiento y queda debido,
      // no pagado: el libro es el que manda.
      expect(segundo).toEqual({ paidMinor: 0, pending: true });
      expect(ledger.post).toHaveBeenCalledTimes(2);
    });

    it("sin nada que deber no se mueve nada", async () => {
      const { service, ledger, provider } = armar();
      ledger.balance.mockResolvedValue(0);
      const pago = await service.payOwner(DUEÑO as never, "settle:x", null);
      expect(pago).toEqual({ paidMinor: 0, pending: false });
      expect(provider.transferToOwner).not.toHaveBeenCalled();
      expect(ledger.post).not.toHaveBeenCalled();
    });
  });
});
