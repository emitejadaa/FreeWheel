import { Module, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SMS_PROVIDER } from "./providers/sms-provider.interface";
import { MockSmsProvider } from "./providers/mock-sms.provider";
import { SmsService } from "./sms.service";

const smsProvider: Provider = {
  provide: SMS_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const which = (config.get<string>("SMS_PROVIDER") ?? "mock").toLowerCase();
    // Only "mock" exists today. When a real gateway is contracted (Twilio,
    // AWS SNS, ...), add its provider class here and select it by name,
    // mirroring PAYMENTS_PROVIDER in src/payments/payments.module.ts.
    if (which !== "mock") {
      throw new Error(
        `Unknown SMS_PROVIDER "${which}" (only "mock" is implemented)`,
      );
    }
    return new MockSmsProvider();
  },
};

@Module({
  providers: [SmsService, smsProvider],
  exports: [SmsService],
})
export class SmsModule {}
