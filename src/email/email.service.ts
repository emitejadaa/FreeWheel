import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {}

  private async send(to: string, subject: string, html: string) {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');
    const from =
      this.configService.get<string>('EMAIL_FROM') ?? 'noreply@freewheel.app';

    if (!apiKey) {
      this.logger.warn(
        `Email no enviado (sin SENDGRID_API_KEY). Para: ${to}, Asunto: ${subject}`,
      );
      return;
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: 'Freewheel' },
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
    });

    if (!res.ok) {
      this.logger.error(`SendGrid error: ${res.status} ${await res.text()}`);
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
        <p style="color:#6b7280;font-size:13px">
          Expira en 15 minutos. No lo compartas con nadie.
        </p>
      </div>`;
    await this.send(email, 'Tu código de verificación — Freewheel', html);
  }

  async sendPasswordReset(
    email: string,
    firstName: string,
    token: string,
    userId: string,
  ) {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ??
      'https://freewheel-5a.vercel.app';
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