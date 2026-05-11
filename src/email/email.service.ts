import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {}

  private createTransporter() {
    const user = this.configService.get<string>('GMAIL_USER');
    const pass = this.configService.get<string>('GMAIL_APP_PASSWORD');

    if (!user || !pass) {
      this.logger.warn('Email no configurado (faltan GMAIL_USER o GMAIL_APP_PASSWORD)');
      return null;
    }

    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }

  private async send(to: string, subject: string, html: string) {
    const transporter = this.createTransporter();
    if (!transporter) return;

    const from = this.configService.get<string>('GMAIL_USER');
    try {
      await transporter.sendMail({ from: `Freewheel <${from}>`, to, subject, html });
    } catch (err) {
      this.logger.error(`Error enviando email: ${err.message}`);
    }
  }

  async sendVerificationCode(email: string, code: string) {
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a4d2e;margin-bottom:8px">Verificá tu email</h2>
        <p style="color:#374151">Tu código de verificación es:</p>
        <div style="font-size:40px;font-weight:bold;letter-spacing:10px;color:#1a4d2e;padding:20px 0">
          ${code}
        </div>
        <p style="color:#6b7280;font-size:13px">Expira en 15 minutos. No lo compartas con nadie.</p>
      </div>`;
    await this.send(email, 'Tu código de verificación — Freewheel', html);
  }

  async sendPasswordReset(email: string, firstName: string, token: string, userId: string) {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ?? 'https://freewheel-5a.vercel.app';
    const resetUrl = `${frontendUrl}/reset-password?token=${token}&uid=${userId}`;

    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a4d2e;margin-bottom:8px">Restablecer contraseña</h2>
        <p style="color:#374151">Hola ${firstName}, recibimos una solicitud para cambiar tu contraseña.</p>
        <a href="${resetUrl}"
           style="display:inline-block;background:#1a4d2e;color:#fff;padding:12px 28px;
                  border-radius:8px;text-decoration:none;font-weight:bold;margin:20px 0">
          Cambiar contraseña
        </a>
        <p style="color:#6b7280;font-size:13px">
          Este enlace expira en 1 hora.<br>
          Si no lo pediste, ignorá este email.
        </p>
      </div>`;
    await this.send(email, 'Restablecer tu contraseña — Freewheel', html);
  }
}