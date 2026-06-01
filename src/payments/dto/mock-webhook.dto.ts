import { IsEnum, IsOptional, IsString } from "class-validator";

export enum MockWebhookEventType {
  CONFIRMED = "mock.payment.confirmed",
  FAILED = "mock.payment.failed",
  REFUNDED = "mock.payment.refunded",
}

export class MockWebhookDto {
  @IsString()
  bookingId!: string;

  @IsEnum(MockWebhookEventType)
  type!: MockWebhookEventType;

  @IsOptional()
  @IsString()
  providerId?: string;
}
