import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import Stripe from "stripe";
import {
  CaptureHoldInput,
  ConnectedAccountResult,
  ConnectedAccountStatus,
  CreateConnectedAccountInput,
  CreateIntentInput,
  EnsureCustomerInput,
  PaymentIntentResult,
  PaymentProvider,
  RefundInput,
  RefundResult,
  ReleaseHoldInput,
  TransferInput,
  TransferResult,
  WebhookEvent,
} from "./payment-provider.interface";

/**
 * EL PROVEEDOR OFFLINE, PARA LOS TESTS.
 *
 * Implementación determinística del mismo contrato, sin red. Existe para que
 * la suite de tests pueda recorrer el circuito entero —crear intents,
 * confirmarlos, capturar y soltar la retención, devolver, transferir— sin
 * depender de que Stripe esté disponible ni de que haya claves cargadas.
 *
 * NO ES EL CAMINO DE PRODUCCIÓN NI EL DE LA DEMO. Los pagos reales, incluso
 * los de prueba, van por StripePaymentsProvider: un simulador siempre dice que
 * sí, y las cosas que rompen un sistema de pagos —una tarjeta rechazada, una
 * que pide autenticación del banco, una disputa— no se prueban contra algo que
 * no las produce.
 *
 * Las firmas de webhook SÍ se verifican de verdad cuando hay
 * STRIPE_WEBHOOK_SECRET (el esquema de firma de Stripe es pura criptografía,
 * no necesita red), así que ese camino de seguridad se ejercita igual que en
 * producción.
 */
@Injectable()
export class MockPaymentsProvider implements PaymentProvider {
  readonly name = "mock";
  private readonly webhookSecret: string;
  private readonly stripe: Stripe;
  private readonly enProduccion: boolean;

  constructor(config: ConfigService) {
    this.webhookSecret = config.get<string>("STRIPE_WEBHOOK_SECRET") ?? "";
    this.enProduccion =
      (config.get<string>("NODE_ENV") ?? process.env.NODE_ENV) === "production";
    // Key-independent: only used for the offline signature helpers.
    this.stripe = new Stripe(
      config.get<string>("STRIPE_SECRET_KEY") ?? "sk_test_mock",
    );
  }

  private id(prefix: string): string {
    return `${prefix}_${randomBytes(12).toString("hex")}`;
  }

  createPaymentIntent(input: CreateIntentInput): Promise<PaymentIntentResult> {
    const id = this.id(`pi_mock_${input.kind.toLowerCase()}`);
    return Promise.resolve({
      id,
      clientSecret: `${id}_secret_${randomBytes(6).toString("hex")}`,
      status: "requires_payment_method",
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
  }

  createDepositHold(input: CreateIntentInput): Promise<PaymentIntentResult> {
    const id = this.id("pi_mock_deposit");
    return Promise.resolve({
      id,
      clientSecret: `${id}_secret_${randomBytes(6).toString("hex")}`,
      status: "requires_payment_method",
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
  }

  captureHold(input: CaptureHoldInput): Promise<PaymentIntentResult> {
    return Promise.resolve({
      id: input.paymentIntentId,
      clientSecret: null,
      status: "succeeded",
      amountMinor: input.amountMinor ?? 0,
      currency: "usd",
    });
  }

  releaseHold(input: ReleaseHoldInput): Promise<PaymentIntentResult> {
    return Promise.resolve({
      id: input.paymentIntentId,
      clientSecret: null,
      status: "canceled",
      amountMinor: 0,
      currency: "usd",
    });
  }

  refund(input: RefundInput): Promise<RefundResult> {
    return Promise.resolve({
      id: this.id("re_mock"),
      amountMinor: input.amountMinor ?? 0,
      status: "succeeded",
    });
  }

  transferToOwner(input: TransferInput): Promise<TransferResult> {
    return Promise.resolve({
      id: this.id("tr_mock"),
      amountMinor: input.amountMinor,
    });
  }

  /**
   * El estado de un intent. Offline no hay nada que consultar: se devuelve una
   * tarjeta de prueba fija para que el camino que guarda las señas antifraude
   * quede ejercitado en los tests y no sea código que nunca corre.
   */
  retrieveIntent(paymentIntentId: string): Promise<PaymentIntentResult> {
    return Promise.resolve({
      id: paymentIntentId,
      clientSecret: null,
      status: "succeeded",
      amountMinor: 0,
      currency: "usd",
      chargeId: `ch_mock_${paymentIntentId}`,
      // En null y no en 0: `0` significaría "se cobró cero", y el control que
      // compara lo cobrado contra lo esperado gritaría en cada test. Null es
      // "no lo sé", que es la verdad de un provider que no cobra nada.
      amountReceivedMinor: null,
      amountCapturableMinor: null,
      card: {
        brand: "visa",
        last4: "4242",
        fingerprint: "fp_mock_4242",
        country: "US",
        cvcCheck: "pass",
        threeDSecure: false,
      },
      risk: { level: "normal", score: 5 },
      failure: null,
    });
  }

  ensureCustomer(input: EnsureCustomerInput): Promise<string> {
    return Promise.resolve(
      `cus_mock_${input.userId.replace(/-/g, "").slice(0, 16)}`,
    );
  }

  createConnectedAccount(
    input: CreateConnectedAccountInput,
  ): Promise<ConnectedAccountResult> {
    return Promise.resolve({
      accountId: `acct_mock_${input.userId.replace(/-/g, "").slice(0, 16)}`,
      onboardingUrl:
        input.returnUrl ?? "https://mock.stripe.local/connect/onboarding",
    });
  }

  getConnectedAccountStatus(
    accountId: string,
  ): Promise<ConnectedAccountStatus> {
    return Promise.resolve({
      accountId,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  }

  constructWebhookEvent(
    rawBody: Buffer,
    signature: string | undefined,
  ): WebhookEvent {
    if (this.webhookSecret && signature) {
      const event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      );
      return {
        id: event.id,
        type: event.type,
        data: {
          object: event.data.object as unknown as Record<string, unknown>,
        },
        livemode: event.livemode,
      };
    }

    // Camino permisivo: sin secreto de firma configurado, se cree lo que llega.
    //
    // En los tests hace falta para poder recorrer el circuito de pago sin una
    // cuenta de Stripe. En producción NO, Y NO HAY VARIABLE QUE LO HABILITE.
    //
    // Antes la había (ALLOW_UNSIGNED_WEBHOOKS) y se sacó a propósito. Este
    // endpoint es público: aceptar un evento sin firma significa que cualquiera
    // que sepa la URL puede mandar un "payment_intent.succeeded" y hacer
    // figurar una reserva como pagada sin haber pagado nunca. Eso no es un
    // modo de demostración, es un agujero, y un agujero que se abre con una
    // variable de entorno es un agujero que un día queda abierto sin que nadie
    // se acuerde.
    if (this.enProduccion) {
      throw new Error(
        "Evento de webhook sin firma verificada. En producción hay que " +
          "configurar STRIPE_WEBHOOK_SECRET y PAYMENTS_PROVIDER=stripe.",
      );
    }

    const parsed = JSON.parse(rawBody.toString("utf8")) as {
      id?: string;
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    return {
      id: parsed.id ?? this.id("evt_mock"),
      type: parsed.type ?? "unknown",
      data: { object: parsed.data?.object ?? {} },
      livemode: false,
    };
  }
}
