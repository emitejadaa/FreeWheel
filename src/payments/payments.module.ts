import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommonModule } from "../common/common.module";
import { EmailModule } from "../email/email.module";
import { PrismaModule } from "../prisma/prisma.module";
import { LedgerModule } from "../ledger/ledger.module";
import { ContractsModule } from "../contracts/contracts.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PricingService } from "./pricing.service";
import { PAYMENT_PROVIDER } from "./providers/payment-provider.interface";
import { MockPaymentsProvider } from "./providers/mock-payments.provider";
import { MercadoPagoPaymentsProvider } from "./providers/mercadopago/mercadopago.provider";
import { UnconfiguredPaymentsProvider } from "./providers/unconfigured-payments.provider";

/**
 * QUIÉN COBRA.
 *
 * Tres caminos, y el orden en que se eligen importa:
 *
 *   1. `mercadopago` (el valor por omisión) con MP_CLIENT_ID y
 *      MP_CLIENT_SECRET cargadas → Mercado Pago de verdad. MP_TEST_MODE decide
 *      si las cuentas que se vinculan son de prueba (por omisión) o reales.
 *   2. `mercadopago` SIN esas credenciales → el provider que no cobra y lo
 *      dice. Cada operación de pago contesta 503 PAYMENTS_NOT_CONFIGURED y
 *      todo el resto de la plataforma funciona.
 *   3. `mock` → provider offline, sin red, SOLO para los tests automatizados.
 *      EN PRODUCCIÓN NO ARRANCA: un servidor que contesta "pagado" sin que
 *      haya pasado plata es peor que uno que no cobra, porque alguien entrega
 *      un auto contra un pago que no existe.
 *
 * Stripe ya no está acá: vive en la rama `pagos-stripe`. Stripe no opera con
 * entidades argentinas, así que en producción no había forma de usarlo sin
 * una sociedad en el exterior (ver CONSULTAS-LEGALES.md §12).
 */
const paymentProvider: Provider = {
  provide: PAYMENT_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const which = (
      config.get<string>("PAYMENTS_PROVIDER") ?? "mercadopago"
    ).toLowerCase();
    const enProduccion =
      (config.get<string>("NODE_ENV") ?? process.env.NODE_ENV) === "production";

    if (which === "mock") {
      if (enProduccion) {
        throw new Error(
          'Refusing to start: PAYMENTS_PROVIDER="mock" en producción. El ' +
            "provider offline no cobra nada y marcaría reservas como pagadas " +
            "sin que haya pasado plata. Usar PAYMENTS_PROVIDER=mercadopago.",
        );
      }
      return new MockPaymentsProvider(config);
    }

    if (
      !config.get<string>("MP_CLIENT_ID") ||
      !config.get<string>("MP_CLIENT_SECRET")
    ) {
      return new UnconfiguredPaymentsProvider();
    }
    return new MercadoPagoPaymentsProvider(config);
  },
};

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    EmailModule,
    LedgerModule,
    ContractsModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PricingService, paymentProvider],
  exports: [PaymentsService, PricingService, LedgerModule],
})
export class PaymentsModule {}
