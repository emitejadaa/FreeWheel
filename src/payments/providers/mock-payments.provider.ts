import type { ConfigService } from "@nestjs/config";
import type {
  ChargebackResult,
  CollectorCredentials,
  CreatePaymentInput,
  OAuthCredentials,
  PaymentProvider,
  PaymentResult,
  ProcessorNotification,
  ProcessorPaymentStatus,
  RefundResult,
} from "./payment-provider.interface";
import {
  huellaDeTarjeta,
  mensajeDelMotivo,
  parseMercadoPagoNotification,
  vencimientoDeReserva,
  verifyMercadoPagoSignature,
} from "./mercadopago/mercadopago.shared";

/**
 * EL PROCESADOR DE LAS PRUEBAS: se comporta como Mercado Pago, sin red.
 *
 * ── Quién decide el resultado ────────────────────────────────────────────────
 * Igual que en el sandbox de Mercado Pago, lo decide el NOMBRE DEL TITULAR, que
 * acá viaja adentro del token de la tarjeta (el front de las pruebas no tiene
 * un formulario de tarjeta de donde sacarlo):
 *
 *   · `tok_APRO_…` → aprobado (o autorizado, si es una reserva de fondos)
 *   · `tok_CONT_…` → en revisión (in_process)
 *   · `tok_OTHE_…` → rechazado, error general
 *   · `tok_FUND_…` → rechazado, fondos insuficientes
 *   · `tok_SECU_…` → rechazado, código de seguridad inválido
 *   · `tok_CALL_…` → rechazado, hay que llamar al banco
 *   · `tok_EXPI_…` → rechazado, vencimiento
 *
 * Cualquier otro token se aprueba. Son los mismos nombres que se escriben en
 * el sandbox real (APRO, CONT, OTHE…), así que una prueba de acá y una prueba
 * a mano contra Mercado Pago hablan el mismo idioma.
 *
 * ── Estado ───────────────────────────────────────────────────────────────────
 * Guarda los pagos en memoria para que consultarlos devuelva lo mismo que se
 * creó, como la API de verdad. Las pruebas pueden cambiar ese estado "del lado
 * de Mercado Pago" (una devolución hecha desde el panel, una contracara) con
 * los métodos `simular…`, y después mandar el aviso firmado.
 *
 * EN PRODUCCIÓN NO ARRANCA (ver payments.module.ts).
 */
export class MockPaymentsProvider implements PaymentProvider {
  readonly name = "mock";
  readonly liveMode = false;

  private seq = 0;
  private readonly pagos = new Map<string, PaymentResult>();
  private readonly idempotencia = new Map<string, string>();
  private readonly contracargos = new Map<string, ChargebackResult>();
  private readonly webhookSecret: string;
  private devolucionesFallan = false;

  constructor(config?: ConfigService) {
    this.webhookSecret = (
      config?.get<string>("MP_WEBHOOK_SECRET") ?? "mp_webhook_secret_for_tests"
    ).trim();
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${Date.now().toString(36)}${this.seq}`;
  }

  createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    // Misma clave de idempotencia, mismo pago: como la API real.
    const repetido = this.idempotencia.get(input.idempotencyKey);
    if (repetido) {
      return Promise.resolve({ ...this.pagos.get(repetido)! });
    }

    const titular = /^tok_([A-Z]{4})_/.exec(input.card.token)?.[1] ?? "APRO";
    const { status, statusDetail } = this.resultadoPara(titular, input.capture);
    const ahora = new Date();
    const pago: PaymentResult = {
      id: this.id("mp_mock_pay"),
      status,
      statusDetail,
      amountMinor: input.amountMinor,
      capturedMinor: status === "approved" ? input.amountMinor : null,
      refundedMinor: 0,
      currency: input.currency.toUpperCase(),
      externalReference: input.externalReference,
      kind: input.kind,
      collectorId: input.collector.userId,
      liveMode: false,
      card: {
        brand: input.card.paymentMethodId,
        last4: "3704",
        fingerprint: huellaDeTarjeta({
          firstSix: "450995",
          lastFour: "3704",
          expMonth: 11,
          expYear: 2030,
          holderDocument: input.card.payer.identification?.number ?? null,
        }),
        country: "AR",
      },
      risk: null,
      failure:
        status === "rejected"
          ? { code: statusDetail, message: mensajeDelMotivo(statusDetail) }
          : null,
      captureBefore:
        status === "authorized" ? vencimientoDeReserva(ahora) : null,
      approvedAt:
        status === "approved" || status === "authorized" ? ahora : null,
    };
    this.pagos.set(pago.id, pago);
    this.idempotencia.set(input.idempotencyKey, pago.id);
    return Promise.resolve({ ...pago });
  }

  getPayment(
    _collector: CollectorCredentials,
    paymentId: string,
  ): Promise<PaymentResult> {
    const pago = this.pagos.get(paymentId);
    if (!pago) {
      return Promise.reject(new Error(`Payment not found: ${paymentId}`));
    }
    return Promise.resolve({ ...pago });
  }

  capturePayment(
    _collector: CollectorCredentials,
    paymentId: string,
    amountMinor: number,
    _idempotencyKey?: string,
  ): Promise<PaymentResult> {
    const pago = this.pagos.get(paymentId);
    if (!pago || pago.status !== "authorized") {
      return Promise.reject(
        new Error(`Payment ${paymentId} is not authorized`),
      );
    }
    if (amountMinor > pago.amountMinor) {
      return Promise.reject(
        new Error("Cannot capture more than the authorized amount"),
      );
    }
    const capturado: PaymentResult = {
      ...pago,
      status: "approved",
      statusDetail: "accredited",
      capturedMinor: amountMinor,
      captureBefore: null,
    };
    this.pagos.set(paymentId, capturado);
    return Promise.resolve({ ...capturado });
  }

  cancelPayment(
    _collector: CollectorCredentials,
    paymentId: string,
    _idempotencyKey?: string,
  ): Promise<PaymentResult> {
    const pago = this.pagos.get(paymentId);
    if (!pago) {
      return Promise.reject(new Error(`Payment not found: ${paymentId}`));
    }
    const cancelado: PaymentResult = {
      ...pago,
      status: "cancelled",
      statusDetail: "by_collector",
      captureBefore: null,
    };
    this.pagos.set(paymentId, cancelado);
    return Promise.resolve({ ...cancelado });
  }

  refundPayment(
    _collector: CollectorCredentials,
    paymentId: string,
    amountMinor: number | null,
    _idempotencyKey?: string,
  ): Promise<RefundResult> {
    if (this.devolucionesFallan) {
      // Lo que contesta Mercado Pago cuando la cuenta del vendedor no tiene
      // saldo para devolver su parte.
      return Promise.reject(
        new Error("Insufficient balance in collector account"),
      );
    }
    const pago = this.pagos.get(paymentId);
    if (!pago || pago.status !== "approved") {
      return Promise.reject(
        new Error(`Payment ${paymentId} is not refundable`),
      );
    }
    const disponible =
      (pago.capturedMinor ?? pago.amountMinor) - pago.refundedMinor;
    const monto = amountMinor ?? disponible;
    if (monto > disponible) {
      return Promise.reject(new Error("Refund exceeds the available amount"));
    }
    const devuelto = pago.refundedMinor + monto;
    this.pagos.set(paymentId, {
      ...pago,
      refundedMinor: devuelto,
      status:
        devuelto >= (pago.capturedMinor ?? pago.amountMinor)
          ? "refunded"
          : "approved",
    });
    return Promise.resolve({
      id: this.id("mp_mock_refund"),
      amountMinor: monto,
      status: "approved",
    });
  }

  getChargeback(
    _collector: CollectorCredentials,
    chargebackId: string,
  ): Promise<ChargebackResult> {
    const contracargo = this.contracargos.get(chargebackId);
    if (!contracargo) {
      return Promise.reject(new Error(`Chargeback not found: ${chargebackId}`));
    }
    return Promise.resolve({ ...contracargo });
  }

  authorizationUrl(input: {
    state: string;
    redirectUri: string;
    codeChallenge?: string | null;
  }): string {
    const url = new URL("https://auth.mercadopago.mock/authorization");
    url.searchParams.set("client_id", "mock_client");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("platform_id", "mp");
    url.searchParams.set("state", input.state);
    url.searchParams.set("redirect_uri", input.redirectUri);
    if (input.codeChallenge) {
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  exchangeAuthorizationCode(input: {
    code: string;
  }): Promise<OAuthCredentials> {
    if (!input.code || input.code.startsWith("invalid")) {
      return Promise.reject(new Error("invalid_grant"));
    }
    return Promise.resolve(this.credenciales(input.code));
  }

  refreshCredentials(refreshToken: string): Promise<OAuthCredentials> {
    return Promise.resolve(
      this.credenciales(refreshToken.replace(/^TG-mock-/, "")),
    );
  }

  verifyNotificationSignature(input: {
    signatureHeader?: string | null;
    requestId?: string | null;
    dataId?: string | null;
  }): void {
    verifyMercadoPagoSignature({ secret: this.webhookSecret, ...input });
  }

  parseNotification(input: {
    body: unknown;
    query: Record<string, unknown>;
  }): ProcessorNotification {
    return parseMercadoPagoNotification(input);
  }

  // ── Lo que las pruebas cambian "del lado de Mercado Pago" ────────────────

  /** Un cambio hecho por fuera de la API de FreeWheel (el panel, el banco). */
  simularCambio(paymentId: string, cambio: Partial<PaymentResult>): void {
    const pago = this.pagos.get(paymentId);
    if (!pago) throw new Error(`Payment not found: ${paymentId}`);
    this.pagos.set(paymentId, { ...pago, ...cambio });
  }

  /** Una contracara abierta por el banco de quien pagó. */
  simularContracargo(paymentId: string): string {
    const pago = this.pagos.get(paymentId);
    if (!pago) throw new Error(`Payment not found: ${paymentId}`);
    const id = this.id("mp_mock_cb");
    this.contracargos.set(id, {
      id,
      paymentIds: [paymentId],
      amountMinor: pago.capturedMinor ?? pago.amountMinor,
      reason: "fraud",
      status: "dispute",
    });
    this.pagos.set(paymentId, { ...pago, status: "charged_back" });
    return id;
  }

  /**
   * Las devoluciones fallan, como cuando el dueño ya retiró la plata de su
   * cuenta y no le alcanza el saldo para devolver su parte.
   */
  simularFallaEnDevoluciones(fallan: boolean): void {
    this.devolucionesFallan = fallan;
  }

  consultar(paymentId: string): PaymentResult | undefined {
    const pago = this.pagos.get(paymentId);
    return pago ? { ...pago } : undefined;
  }

  // ── Ayudantes ──────────────────────────────────────────────────────────

  private credenciales(code: string): OAuthCredentials {
    const limpio = code.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "x";
    return {
      userId: `mp_user_${limpio}`,
      accessToken: `TEST-mock-access-${limpio}`,
      refreshToken: `TG-mock-${limpio}`,
      publicKey: `TEST-mock-pk-${limpio}`,
      expiresAt: new Date(Date.now() + 180 * 24 * 3_600_000),
      liveMode: false,
    };
  }

  private resultadoPara(
    titular: string,
    capture: boolean,
  ): { status: ProcessorPaymentStatus; statusDetail: string } {
    switch (titular) {
      case "CONT":
        return { status: "in_process", statusDetail: "pending_contingency" };
      case "OTHE":
        return { status: "rejected", statusDetail: "cc_rejected_other_reason" };
      case "FUND":
        return {
          status: "rejected",
          statusDetail: "cc_rejected_insufficient_amount",
        };
      case "SECU":
        return {
          status: "rejected",
          statusDetail: "cc_rejected_bad_filled_security_code",
        };
      case "CALL":
        return {
          status: "rejected",
          statusDetail: "cc_rejected_call_for_authorize",
        };
      case "EXPI":
        return {
          status: "rejected",
          statusDetail: "cc_rejected_bad_filled_date",
        };
      default:
        return capture
          ? { status: "approved", statusDetail: "accredited" }
          : { status: "authorized", statusDetail: "pending_capture" };
    }
  }
}
