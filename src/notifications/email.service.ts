import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as sgMail from '@sendgrid/mail';

type AccountVerificationEmailInput = {
  to: string;
  code: string;
  expiresAt: Date;
};

@Injectable()
export class EmailService {
  private readonly mailClient: {
    setApiKey: (apiKey: string) => void;
    send: (message: {
      to: string;
      from: string;
      subject: string;
      html: string;
    }) => Promise<unknown>;
  };

  constructor() {
    this.mailClient = this.resolveMailClient();

    if (process.env.SENDGRID_API_KEY) {
      this.mailClient.setApiKey(process.env.SENDGRID_API_KEY);
    }
  }

  async sendAccountVerificationEmail(
    input: AccountVerificationEmailInput,
  ): Promise<void> {
    const subject = 'Verificá tu cuenta de FreeWheel';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Verificación de email</h2>
        <p>Ingresá este código para verificar tu cuenta:</p>
        <pre style="background:#f4f4f4;padding:12px;border-radius:8px;font-size:24px;font-weight:bold;letter-spacing:4px;">${input.code}</pre>
        <p>Expira el ${input.expiresAt.toISOString()}.</p>
      </div>
    `;

    if (!process.env.SENDGRID_API_KEY) {
      console.info(
        `[EMAIL:DEV] Verification email for ${input.to}. Code: ${input.code}`,
      );
      return;
    }

    try {
      await this.mailClient.send({
        to: input.to,
        from: process.env.SENDGRID_FROM_EMAIL || 'noreply@freewheel.com',
        subject,
        html,
      });
    } catch (error) {
      console.error('Error enviando email de verificación', error);
      throw new InternalServerErrorException(
        'No se pudo enviar el email de verificación.',
      );
    }
  }

  private resolveMailClient() {
    const client = (sgMail as any).default ?? sgMail;

    if (
      typeof client?.setApiKey !== 'function' ||
      typeof client?.send !== 'function'
    ) {
      throw new InternalServerErrorException(
        'La librería de SendGrid no está disponible con el formato esperado.',
      );
    }

    return client as {
      setApiKey: (apiKey: string) => void;
      send: (message: {
        to: string;
        from: string;
        subject: string;
        html: string;
      }) => Promise<unknown>;
    };
  }
}
