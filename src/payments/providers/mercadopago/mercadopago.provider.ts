import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type {
  ChargebackResult,
  CollectorCredentials,
  CreatePaymentInput,
  OAuthCredentials,
  PaymentProvider,
  PaymentResult,
  ProcessorNotification,
  RefundResult,
} from "../payment-provider.interface";
import {
  aMinor,
  aPesos,
  leerPago,
  parseMercadoPagoNotification,
  verifyMercadoPagoSignature,
} from "./mercadopago.shared";

/**
 * UN ERROR DE LA API DE MERCADO PAGO, con lo que hace falta para contarlo.
 *
 * Un pago RECHAZADO no llega por acá: Mercado Pago contesta 201 con
 * `status: rejected`, y eso es un resultado, no un error. Esto es para lo que
 * no se pudo ni intentar: un token de tarjeta vencido, un access token que ya
 * no sirve, la API caída.
 */
export class MercadoPagoApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MercadoPagoApiError";
  }
}

const API = "https://api.mercadopago.com";

/** Un valor de la API como texto, solo si es texto o número. */
function texto(valor: unknown): string {
  return typeof valor === "string" || typeof valor === "number"
    ? String(valor)
    : "";
}
const AUTH = "https://auth.mercadopago.com/authorization";
const TIMEOUT_MS = 20_000;

/**
 * MERCADO PAGO, POR SU API REST Y SIN EL SDK OFICIAL.
 *
 * ── Por qué no el SDK ────────────────────────────────────────────────────────
 * El SDK de Node guarda la clave de idempotencia en el MISMO objeto de
 * configuración que después reusa (PaymentRefund.create, por ejemplo, hace
 * `this.config.options = {...this.config.options, ...requestOptions}`). Una
 * configuración compartida entre dos operaciones arrastra la clave de la
 * primera a la segunda, y Mercado Pago contesta lo que corresponde a una
 * clave repetida: la respuesta de la operación anterior. En plata ajena, un
 * reembolso que "salió bien" sin haber pasado es el peor error posible.
 *
 * La API REST es chica y está documentada. Acá cada llamada lleva sus propias
 * cabeceras y nada se comparte entre llamadas.
 *
 * ── Con qué token se opera ───────────────────────────────────────────────────
 * Con el del DUEÑO, siempre (ver payment-provider.interface.ts): el cobro se
 * crea en su cuenta y FreeWheel cobra su parte como `application_fee`. Las
 * credenciales de FreeWheel (client id y secret) solo se usan para el OAuth.
 */
export class MercadoPagoPaymentsProvider implements PaymentProvider {
  readonly name = "mercadopago";
  readonly liveMode: boolean;
  private readonly logger = new Logger(MercadoPagoPaymentsProvider.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookSecret: string;
  private readonly usePkce: boolean;

  constructor(
    config: ConfigService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.clientId = (config.get<string>("MP_CLIENT_ID") ?? "").trim();
    this.clientSecret = (config.get<string>("MP_CLIENT_SECRET") ?? "").trim();
    this.webhookSecret = (config.get<string>("MP_WEBHOOK_SECRET") ?? "").trim();
    // Modo de prueba por omisión: lo que tiene que ser una decisión explícita
    // es mover plata de verdad, no lo contrario.
    this.liveMode =
      (config.get<string>("MP_TEST_MODE") ?? "true").trim().toLowerCase() ===
      "false";
    this.usePkce =
      (config.get<string>("MP_OAUTH_PKCE") ?? "true").trim().toLowerCase() !==
      "false";
    this.logger.log(
      `Mercado Pago inicializado en modo ${this.liveMode ? "PRODUCCIÓN" : "PRUEBA"}`,
    );
  }

  get pkceEnabled(): boolean {
    return this.usePkce;
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    const cuerpo: Record<string, unknown> = {
      transaction_amount: aPesos(input.amountMinor),
      token: input.card.token,
      installments: input.card.installments,
      payment_method_id: input.card.paymentMethodId,
      ...(input.card.issuerId
        ? { issuer_id: Number(input.card.issuerId) }
        : {}),
      capture: input.capture,
      binary_mode: false,
      description: input.description.slice(0, 250),
      external_reference: input.externalReference,
      ...(input.statementDescriptor
        ? { statement_descriptor: input.statementDescriptor.slice(0, 22) }
        : {}),
      ...(input.notificationUrl
        ? { notification_url: input.notificationUrl }
        : {}),
      ...(input.applicationFeeMinor > 0
        ? { application_fee: aPesos(input.applicationFeeMinor) }
        : {}),
      metadata: {
        booking_id: input.bookingId,
        kind: input.kind,
        ...input.metadata,
      },
      payer: {
        email: input.card.payer.email,
        ...(input.card.payer.identification
          ? { identification: input.card.payer.identification }
          : {}),
        ...(input.card.payer.firstName
          ? { first_name: input.card.payer.firstName }
          : {}),
        ...(input.card.payer.lastName
          ? { last_name: input.card.payer.lastName }
          : {}),
      },
      ...(input.items?.length
        ? {
            additional_info: {
              items: input.items.map((item) => ({
                id: item.id,
                title: item.title,
                description: item.description,
                quantity: item.quantity,
                unit_price: aPesos(item.unitPriceMinor),
                category_id: item.categoryId ?? "services",
              })),
            },
          }
        : {}),
    };

    const json = await this.request("POST", "/v1/payments", {
      token: input.collector.accessToken,
      body: cuerpo,
      idempotencyKey: input.idempotencyKey,
      deviceSessionId: input.card.deviceSessionId ?? null,
    });
    return leerPago(json);
  }

  async getPayment(
    collector: CollectorCredentials,
    paymentId: string,
  ): Promise<PaymentResult> {
    const json = await this.request(
      "GET",
      `/v1/payments/${encodeURIComponent(paymentId)}`,
      { token: collector.accessToken },
    );
    return leerPago(json);
  }

  async capturePayment(
    collector: CollectorCredentials,
    paymentId: string,
    amountMinor: number,
    idempotencyKey: string,
  ): Promise<PaymentResult> {
    const json = await this.request(
      "PUT",
      `/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        token: collector.accessToken,
        body: { capture: true, transaction_amount: aPesos(amountMinor) },
        idempotencyKey,
      },
    );
    return leerPago(json);
  }

  async cancelPayment(
    collector: CollectorCredentials,
    paymentId: string,
    idempotencyKey: string,
  ): Promise<PaymentResult> {
    const json = await this.request(
      "PUT",
      `/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        token: collector.accessToken,
        body: { status: "cancelled" },
        idempotencyKey,
      },
    );
    return leerPago(json);
  }

  async refundPayment(
    collector: CollectorCredentials,
    paymentId: string,
    amountMinor: number | null,
    idempotencyKey: string,
  ): Promise<RefundResult> {
    const json = await this.request(
      "POST",
      `/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
      {
        token: collector.accessToken,
        body: amountMinor != null ? { amount: aPesos(amountMinor) } : {},
        idempotencyKey,
      },
    );
    return {
      id: String(json.id),
      amountMinor: aMinor(json.amount),
      status: typeof json.status === "string" ? json.status : "approved",
    };
  }

  async getChargeback(
    collector: CollectorCredentials,
    chargebackId: string,
  ): Promise<ChargebackResult> {
    const json = await this.request(
      "GET",
      `/v1/chargebacks/${encodeURIComponent(chargebackId)}`,
      { token: collector.accessToken },
    );
    const pagos = Array.isArray(json.payments) ? json.payments : [];
    return {
      id: String(json.id),
      paymentIds: pagos.map((p) =>
        typeof p === "object" && p !== null
          ? String((p as Record<string, unknown>).id)
          : String(p),
      ),
      amountMinor: aMinor(json.amount),
      reason: typeof json.reason === "string" ? json.reason : null,
      status: typeof json.stage === "string" ? json.stage : null,
    };
  }

  authorizationUrl(input: {
    state: string;
    redirectUri: string;
    codeChallenge?: string | null;
  }): string {
    this.assertOAuthConfigured();
    const url = new URL(AUTH);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("platform_id", "mp");
    url.searchParams.set("state", input.state);
    url.searchParams.set("redirect_uri", input.redirectUri);
    if (this.usePkce && input.codeChallenge) {
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string | null;
  }): Promise<OAuthCredentials> {
    this.assertOAuthConfigured();
    const json = await this.request("POST", "/oauth/token", {
      body: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        ...(this.usePkce && input.codeVerifier
          ? { code_verifier: input.codeVerifier }
          : {}),
        // En modo de prueba se piden credenciales de prueba para la cuenta
        // del dueño; sin esto, un dueño de prueba recibiría un token real.
        test_token: this.liveMode ? "false" : "true",
      },
    });
    return this.leerCredenciales(json);
  }

  async refreshCredentials(refreshToken: string): Promise<OAuthCredentials> {
    this.assertOAuthConfigured();
    const json = await this.request("POST", "/oauth/token", {
      body: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      },
    });
    return this.leerCredenciales(json);
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

  // ── La llamada HTTP ──────────────────────────────────────────────────────

  private leerCredenciales(json: Record<string, unknown>): OAuthCredentials {
    const expiraEn = Number(json.expires_in ?? 15_552_000);
    return {
      userId: String(json.user_id),
      accessToken: String(json.access_token),
      refreshToken: texto(json.refresh_token),
      publicKey: texto(json.public_key),
      expiresAt: new Date(Date.now() + expiraEn * 1000),
      liveMode: json.live_mode === true,
    };
  }

  private assertOAuthConfigured(): void {
    if (!this.clientId || !this.clientSecret) {
      throw new MercadoPagoApiError(
        503,
        "MP_OAUTH_NOT_CONFIGURED",
        "Faltan MP_CLIENT_ID y MP_CLIENT_SECRET para vincular cuentas.",
        false,
      );
    }
  }

  /**
   * Una llamada, con su propio timeout y un solo reintento ante un corte de
   * red o un 5xx. Reintentar es seguro porque toda escritura lleva su clave
   * de idempotencia: la segunda vez, Mercado Pago devuelve lo mismo.
   */
  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: {
      token?: string;
      body?: Record<string, unknown>;
      idempotencyKey?: string;
      deviceSessionId?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    const cabeceras: Record<string, string> = {
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.idempotencyKey
        ? { "X-Idempotency-Key": opts.idempotencyKey }
        : {}),
      ...(opts.deviceSessionId
        ? { "X-meli-session-id": opts.deviceSessionId }
        : {}),
    };

    let ultimo: unknown = null;
    for (let intento = 0; intento < 2; intento += 1) {
      const controlador = new AbortController();
      const corte = setTimeout(() => controlador.abort(), TIMEOUT_MS);
      try {
        const respuesta = await this.fetchImpl(`${API}${path}`, {
          method,
          headers: cabeceras,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: controlador.signal,
        });
        const texto = await respuesta.text();
        const json = texto
          ? (JSON.parse(texto) as Record<string, unknown>)
          : {};
        if (respuesta.ok) return json;

        const error = this.errorDe(respuesta.status, json);
        if (!error.retryable || intento === 1) throw error;
        ultimo = error;
      } catch (error) {
        if (error instanceof MercadoPagoApiError) {
          if (!error.retryable || intento === 1) throw error;
          ultimo = error;
        } else {
          // Corte de red o timeout: se reintenta una vez.
          const message =
            error instanceof Error ? error.message : String(error);
          ultimo = new MercadoPagoApiError(
            503,
            "MP_UNREACHABLE",
            `No se pudo hablar con Mercado Pago: ${message}`,
            true,
          );
          if (intento === 1) throw ultimo;
        }
      } finally {
        clearTimeout(corte);
      }
      await new Promise((listo) => setTimeout(listo, 400));
    }
    throw ultimo;
  }

  private errorDe(
    status: number,
    json: Record<string, unknown>,
  ): MercadoPagoApiError {
    const causa = Array.isArray(json.cause)
      ? (json.cause[0] as Record<string, unknown> | undefined)
      : undefined;
    const code =
      (typeof causa?.code === "string" || typeof causa?.code === "number"
        ? String(causa.code)
        : null) ??
      (typeof json.error === "string" ? json.error : null) ??
      `http_${status}`;
    const message =
      (typeof causa?.description === "string" ? causa.description : null) ??
      (typeof json.message === "string" ? json.message : null) ??
      `Mercado Pago contestó ${status}`;
    return new MercadoPagoApiError(
      status,
      code,
      message,
      status >= 500 || status === 429,
    );
  }
}
