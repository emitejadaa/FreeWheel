/**
 * Stand-in for SmsService used in tests (mirror of FakeEmailService). The real
 * service hands verification codes to the configured SMS provider (a logging
 * mock until a real gateway exists); tests capture them here to drive the
 * phone-confirm flow.
 */
export class FakeSmsService {
  private readonly codes = new Map<string, string>();

  sendVerificationCode(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
    return Promise.resolve();
  }

  /** The most recent verification code sent to this phone number. */
  lastCode(phone: string): string | undefined {
    return this.codes.get(phone);
  }
}
