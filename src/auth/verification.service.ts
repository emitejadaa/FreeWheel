import { Injectable } from '@nestjs/common';
import { SendgridService } from '../notifications/sendgrid.service';
import { TwilioService } from '../notifications/twilio.service';

@Injectable()
export class VerificationService {
  constructor(
    private sendgridService: SendgridService,
    private twilioService: TwilioService,
  ) {}

  async sendEmailVerification(email: string, code: string): Promise<void> {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Verifica tu email en FreeWheel</h2>
        <p style="color: #666; font-size: 16px;">Tu código de verificación es:</p>
        <div style="background-color: #f0f0f0; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="color: #007bff; font-size: 32px; letter-spacing: 5px; margin: 0; text-align: center; font-weight: bold;">${code}</p>
        </div>
        <p style="color: #999; font-size: 14px;">Este código expira en 15 minutos.</p>
        <p style="color: #999; font-size: 12px;">Si no solicitaste este código, ignora este email.</p>
      </div>
    `;

    await this.sendgridService.sendEmail(
      email,
      'Código de verificación de FreeWheel',
      html,
    );
  }

  async sendMobileVerification(mobile: string, code: string): Promise<void> {
    const message = `Tu código de verificación de FreeWheel es: ${code}. Este código expira en 15 minutos.`;
    await this.twilioService.sendSms(mobile, message);
  }

  validatePhoneNumber(phone: string): boolean {
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    return phoneRegex.test(phone.replace(/\D/g, ''));
  }
}
