import { Inject, Injectable } from "@nestjs/common";
import { SMS_PROVIDER } from "./providers/sms-provider.interface";
import type { SmsProvider } from "./providers/sms-provider.interface";

/**
 * Thin facade over the configured SMS provider. Exists as a class token so
 * tests can override it wholesale (overrideProvider(SmsService)), exactly like
 * EmailService is overridden with FakeEmailService in test/helpers/app.ts.
 */
@Injectable()
export class SmsService {
  constructor(@Inject(SMS_PROVIDER) private readonly provider: SmsProvider) {}

  async sendVerificationCode(phone: string, code: string): Promise<void> {
    await this.provider.sendVerificationCode(phone, code);
  }
}
