import { Injectable, BadRequestException } from '@nestjs/common';
import twilio from 'twilio';

@Injectable()
export class TwilioService {
  private client: any;

  constructor() {
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      this.client = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN,
      );
    }
  }

  async sendSms(to: string, body: string): Promise<void> {
    if (!this.client) {
      console.log(`[TWILIO] SMS not sent (credentials not configured): ${to}`);
      return;
    }

    try {
      await this.client.messages.create({
        body,
        from: process.env.TWILIO_PHONE_NUMBER,
        to,
      });
    } catch (error) {
      console.error('Error enviando SMS:', error);
      throw new BadRequestException('Error enviando SMS');
    }
  }
}
