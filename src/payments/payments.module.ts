import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommonModule } from "../common/common.module";
import { EmailModule } from "../email/email.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PricingService } from "./pricing.service";
import { PAYMENT_PROVIDER } from "./providers/payment-provider.interface";
import { MockPaymentsProvider } from "./providers/mock-payments.provider";
import { StripePaymentsProvider } from "./providers/stripe-payments.provider";

const paymentProvider: Provider = {
  provide: PAYMENT_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const which = (
      config.get<string>("PAYMENTS_PROVIDER") ?? "mock"
    ).toLowerCase();
    return which === "stripe"
      ? new StripePaymentsProvider(config)
      : new MockPaymentsProvider(config);
  },
};

@Module({
  imports: [PrismaModule, CommonModule, EmailModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PricingService, paymentProvider],
  exports: [PaymentsService, PricingService],
})
export class PaymentsModule {}
