import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
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
  SavedCard,
  TransferInput,
  TransferResult,
  WebhookEvent,
} from "./payment-provider.interface";

/**
 * EL PROVEEDOR QUE NO COBRA NADA Y LO DICE.
 *
 * Es lo que queda cuando este deploy no tiene configurado Stripe. Cada
 * operación de pago contesta 503 con un código que el front puede reconocer;
 * todo el resto de la plataforma —publicar, buscar, chatear, verificarse—
 * funciona normalmente.
 *
 * ── Por qué existe en vez de simplemente no arrancar ────────────────────────
 * La alternativa era que el servidor se negara a levantar sin
 * STRIPE_SECRET_KEY. Eso convierte "falta cargar una clave" en "la API entera
 * está caída": nadie puede entrar, ni buscar un auto, ni terminar de
 * verificarse, por una variable que solo hace falta para cobrar. Un deploy
 * roto entero es una respuesta desproporcionada a una función que falta.
 *
 * ── Y por qué NO es el provider mock ────────────────────────────────────────
 * El mock dice que sí a todo: crea intents, los da por cobrados, marca las
 * reservas como pagas. Usarlo como respaldo sería silencioso y peligroso —la
 * plataforma parecería estar cobrando sin que haya pasado un peso, y alguien
 * entregaría un auto contra un pago que no existe. Fallar fuerte y decir por
 * qué es lo único aceptable acá.
 *
 * Lo que hay que cargar está en `.env.example`, sección "Pagos".
 */
@Injectable()
export class UnconfiguredPaymentsProvider implements PaymentProvider {
  readonly name = "unconfigured";
  private readonly logger = new Logger(UnconfiguredPaymentsProvider.name);

  constructor() {
    this.logger.warn(
      "Pagos DESACTIVADOS: falta STRIPE_SECRET_KEY. La API funciona entera " +
        "salvo cobrar; cada operación de pago contesta 503 " +
        "PAYMENTS_NOT_CONFIGURED. Ver .env.example, sección Pagos.",
    );
  }

  private fail(): never {
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: "PAYMENTS_NOT_CONFIGURED",
      message:
        "Los pagos no están disponibles en este momento. Estamos terminando " +
        "de configurarlos: el resto de la aplicación funciona normalmente.",
    });
  }

  createPaymentIntent(_input: CreateIntentInput): Promise<PaymentIntentResult> {
    this.fail();
  }
  createDepositHold(_input: CreateIntentInput): Promise<PaymentIntentResult> {
    this.fail();
  }
  captureHold(_input: CaptureHoldInput): Promise<PaymentIntentResult> {
    this.fail();
  }
  releaseHold(_input: ReleaseHoldInput): Promise<PaymentIntentResult> {
    this.fail();
  }
  retrieveIntent(_paymentIntentId: string): Promise<PaymentIntentResult> {
    this.fail();
  }
  refund(_input: RefundInput): Promise<RefundResult> {
    this.fail();
  }
  transferToOwner(_input: TransferInput): Promise<TransferResult> {
    this.fail();
  }
  ensureCustomer(_input: EnsureCustomerInput): Promise<string> {
    this.fail();
  }
  listSavedCards(_customerId: string): Promise<SavedCard[]> {
    this.fail();
  }
  createConnectedAccount(
    _input: CreateConnectedAccountInput,
  ): Promise<ConnectedAccountResult> {
    this.fail();
  }
  getConnectedAccountStatus(
    _accountId: string,
  ): Promise<ConnectedAccountStatus> {
    this.fail();
  }

  /**
   * El webhook se rechaza y NO se procesa. Sin claves no hay con qué verificar
   * la firma, y aceptar un aviso sin verificar sería dejar que cualquiera
   * declare una reserva como pagada.
   */
  constructWebhookEvent(
    _rawBody: Buffer,
    _signature: string | undefined,
  ): WebhookEvent {
    throw new Error(
      "Este deploy no tiene Stripe configurado: no hay con qué verificar la " +
        "firma del aviso, así que no se procesa.",
    );
  }
}
