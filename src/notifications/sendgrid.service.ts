import { Injectable, BadRequestException } from '@nestjs/common';
import * as sgMail from '@sendgrid/mail';

@Injectable()
export class SendgridService {
  constructor() {
    if (process.env.SENDGRID_API_KEY) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    }
  }

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    if (!process.env.SENDGRID_API_KEY) {
      console.log(`[SENDGRID] Email not sent (API key not configured): ${to}`);
      return;
    }

    try {
      const msg = {
        to,
        from: process.env.SENDGRID_FROM_EMAIL || 'noreply@freewheel.com',
        subject,
        html,
      };
      await sgMail.send(msg);
    } catch (error) {
      console.error('Error enviando email:', error);
      throw new BadRequestException('Error enviando email');
    }
  }
}
