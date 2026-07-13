/**
 * Provider-agnostic SMS boundary, mirroring the payments provider pattern
 * (src/payments/providers/payment-provider.interface.ts). Today only the mock
 * provider exists; a real provider (Twilio, AWS SNS, ...) implements this
 * interface and is wired in SmsModule via the SMS_PROVIDER env var without
 * touching any caller.
 */

export const SMS_PROVIDER = Symbol("SMS_PROVIDER");

export interface SmsProvider {
  readonly name: string;
  sendVerificationCode(phone: string, code: string): Promise<void>;
}
