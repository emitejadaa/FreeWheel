import { Logger } from "@nestjs/common";
import { SmsProvider } from "./sms-provider.interface";

/**
 * Development stand-in for a real SMS gateway: logs the code instead of
 * sending it. The code is never returned in HTTP responses, so it cannot leak
 * to clients; in production a real provider (e.g. Twilio) must be configured.
 */
export class MockSmsProvider implements SmsProvider {
  readonly name = "mock";

  private readonly logger = new Logger(MockSmsProvider.name);

  sendVerificationCode(phone: string, code: string): Promise<void> {
    this.logger.log(`[SMS mock] verification code for ${phone}: ${code}`);
    return Promise.resolve();
  }
}
