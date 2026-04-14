import { Module } from '@nestjs/common';
import { SendgridService } from './sendgrid.service';
import { TwilioService } from './twilio.service';

@Module({
  providers: [SendgridService, TwilioService],
  exports: [SendgridService, TwilioService],
})
export class NotificationsModule {}
