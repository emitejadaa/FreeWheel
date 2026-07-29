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

  /**
   * True cuando NO hay una pasarela de SMS contratada (el proveedor es el mock,
   * que solo escribe el código en el log). Mandar un SMS a un número real es
   * siempre un servicio pago, así que mientras no haya una contratada el código
   * del teléfono se entrega por email, que sí es gratis y llega de verdad.
   * Lo consulta VerificationService para elegir el canal.
   */
  get isMock(): boolean {
    return this.provider.name === "mock";
  }

  get providerName(): string {
    return this.provider.name;
  }
}
