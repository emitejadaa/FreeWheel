import { Injectable, InternalServerErrorException } from '@nestjs/common';
import twilio from 'twilio';

type PhoneVerificationSmsInput = {
  to: string;
  code: string;
  expiresAt: Date;
};

@Injectable()
export class SmsService {
  private readonly client?: ReturnType<typeof twilio>;

  constructor() {
    const twilioFactory = this.resolveTwilioFactory();

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      this.client = twilioFactory(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN,
      );
    }
  }

  async sendPhoneVerificationCode(
    input: PhoneVerificationSmsInput,
  ): Promise<void> {
    const body = `Tu código de verificación de FreeWheel es ${input.code}. Expira el ${input.expiresAt.toISOString()}.`;

    if (!this.client || !process.env.TWILIO_PHONE_NUMBER) {
      console.info(
        `[SMS:DEV] Verification SMS for ${input.to}. Code: ${input.code}`,
      );
      return;
    }

    try {
      await this.client.messages.create({
        body,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: input.to,
      });
    } catch (error) {
      console.error('Error enviando SMS de verificación', error);
      throw new InternalServerErrorException(
        'No se pudo enviar el SMS de verificación.',
      );
    }
  }

  private resolveTwilioFactory() {
    return ((twilio as any).default ?? twilio) as typeof twilio;
  }
}
