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
import { StripePaymentsProvider } from "./providers/stripe-payments.provider";
import { UnconfiguredPaymentsProvider } from "./providers/unconfigured-payments.provider";

/**
 * QUIÉN COBRA.
 *
 * Tres caminos, y el orden en que se eligen importa:
 *
 *   1. `stripe` (el valor por omisión) con STRIPE_SECRET_KEY cargada → Stripe
 *      de verdad, en modo de prueba. Es lo que corre en la demo y lo que va a
 *      correr en producción: el día que se cobre en serio, lo que cambia son
 *      las claves.
 *   2. `stripe` SIN la clave → el provider que no cobra y lo dice. Cada
 *      operación de pago contesta 503 PAYMENTS_NOT_CONFIGURED y todo el resto
 *      de la plataforma funciona. La alternativa era negarse a arrancar, o sea
 *      convertir "falta cargar una clave" en "la API entera está caída", que
 *      es una respuesta desproporcionada a una función que falta.
 *   3. `mock` → provider offline, sin red, SOLO para los tests automatizados.
 *      EN PRODUCCIÓN NO ARRANCA: un servidor que contesta "pagado" sin que
 *      haya pasado plata es peor que uno que no cobra, porque alguien entrega
 *      un auto contra un pago que no existe.
 *
 * El valor por omisión era "mock" y se cambió: un deploy al que se le olvidara
 * la variable arrancaba con pagos de mentira y nadie se enteraba hasta que
 * alguien preguntara dónde estaba su plata.
 */
const paymentProvider: Provider = {
  provide: PAYMENT_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const which = (
      config.get<string>("PAYMENTS_PROVIDER") ?? "stripe"
    ).toLowerCase();
    const enProduccion =
      (config.get<string>("NODE_ENV") ?? process.env.NODE_ENV) === "production";

    if (which === "mock") {
      if (enProduccion) {
        throw new Error(
          'Refusing to start: PAYMENTS_PROVIDER="mock" en producción. El ' +
            "provider offline no cobra nada y marcaría reservas como pagadas " +
            "sin que haya pasado plata. Usar PAYMENTS_PROVIDER=stripe.",
        );
      }
      return new MockPaymentsProvider(config);
    }

    if (!config.get<string>("STRIPE_SECRET_KEY")) {
      return new UnconfiguredPaymentsProvider();
    }
    return new StripePaymentsProvider(config);
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
