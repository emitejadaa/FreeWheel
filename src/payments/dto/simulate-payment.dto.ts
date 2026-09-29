import { IsIn, IsOptional } from "class-validator";
import type { PaymentRecordKindLike } from "../providers/payment-provider.interface";

/** Tramo del pago a simular. Sin `kind`, mock-confirm completa todos. */
export class SimulatePaymentDto {
  @IsOptional()
  @IsIn(["SENA", "BALANCE", "DEPOSIT_HOLD"])
  kind?: PaymentRecordKindLike;
}
