import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  ChargebackResult,
  OAuthCredentials,
  PaymentProvider,
  PaymentResult,
  ProcessorNotification,
  RefundResult,
} from "./payment-provider.interface";
import { parseMercadoPagoNotification } from "./mercadopago/mercadopago.shared";

/**
 * EL PROVEEDOR QUE NO COBRA NADA Y LO DICE.
 *
 * Es lo que queda cuando este deploy no tiene configurado Mercado Pago. Cada
 * operación de pago contesta 503 con un código que el front puede reconocer;
 * todo el resto de la plataforma —publicar, buscar, chatear, verificarse—
 * funciona normalmente.
 *
 * ── Por qué existe en vez de simplemente no arrancar ────────────────────────
 * La alternativa era que el servidor se negara a levantar sin credenciales de
 * pago. Eso convierte "falta cargar una clave" en "la API entera está caída":
 * nadie puede entrar, ni buscar un auto, ni terminar de verificarse, por una
 * variable que solo hace falta para cobrar.
 *
 * ── Y por qué NO es el provider mock ────────────────────────────────────────
 * El mock dice que sí a todo. Usarlo como respaldo sería silencioso y
 * peligroso: la plataforma parecería estar cobrando sin que haya pasado un
 * peso, y alguien entregaría un auto contra un pago que no existe.
 *
 * Lo que hay que cargar está en `.env.example`, sección "Mercado Pago".
 */
@Injectable()
export class UnconfiguredPaymentsProvider implements PaymentProvider {
  readonly name = "unconfigured";
  readonly liveMode = false;
  private readonly logger = new Logger(UnconfiguredPaymentsProvider.name);

  constructor() {
    this.logger.warn(
      "Pagos DESACTIVADOS: faltan MP_CLIENT_ID y MP_CLIENT_SECRET. La API " +
        "funciona entera salvo cobrar; cada operación de pago contesta 503 " +
        "PAYMENTS_NOT_CONFIGURED. Ver .env.example, sección Mercado Pago.",
    );
  }

  private fail(): never {
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: "PAYMENTS_NOT_CONFIGURED",
      message:
        "Los pagos no están disponibles en este momento: el servidor no " +
        "tiene configurado Mercado Pago.",
    });
  }

  createPayment(): Promise<PaymentResult> {
    return this.fail();
  }
  getPayment(): Promise<PaymentResult> {
    return this.fail();
  }
  capturePayment(): Promise<PaymentResult> {
    return this.fail();
  }
  cancelPayment(): Promise<PaymentResult> {
    return this.fail();
  }
  refundPayment(): Promise<RefundResult> {
    return this.fail();
  }
  getChargeback(): Promise<ChargebackResult> {
    return this.fail();
  }
  authorizationUrl(): string {
    return this.fail();
  }
  exchangeAuthorizationCode(): Promise<OAuthCredentials> {
    return this.fail();
  }
  refreshCredentials(): Promise<OAuthCredentials> {
    return this.fail();
  }

  /** Un aviso a un deploy sin pagos no se procesa: se rechaza. */
  verifyNotificationSignature(): void {
    this.fail();
  }

  parseNotification(input: {
    body: unknown;
    query: Record<string, unknown>;
  }): ProcessorNotification {
    return parseMercadoPagoNotification(input);
  }
}
