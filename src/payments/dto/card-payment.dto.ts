import { Type } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import type { CardPaymentInput } from "../providers/payment-provider.interface";

export class CardIdentificationDto {
  @IsIn(["DNI", "CUIT", "CUIL", "CI", "LC", "LE", "Otro"])
  type!: string;

  @IsString()
  @Matches(/^[0-9A-Za-z]{5,20}$/)
  number!: string;
}

export class CardPayerDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CardIdentificationDto)
  identification?: CardIdentificationDto;
}

/**
 * LO QUE MANDA EL FORMULARIO DE TARJETA DE MERCADO PAGO (Card Payment Brick).
 *
 * Los nombres son los del `formData` del Brick, en snake_case, A PROPÓSITO:
 * el front lo reenvía tal cual, sin traducir nada. Cada campo que el front
 * tenga que renombrar es un lugar donde equivocarse.
 *
 * `transaction_amount` se acepta y SE IGNORA: el importe sale de los precios
 * congelados de la reserva, nunca del cliente. Si se tomara de acá, alguien
 * podría pagar una reserva de 3300 mandando 1.
 */
export class CardPaymentDto {
  @IsString()
  @Length(8, 200)
  token!: string;

  @IsString()
  @Matches(/^[a-z0-9_]{2,40}$/)
  payment_method_id!: string;

  @IsOptional()
  @Type(() => String)
  @IsString()
  @Length(1, 20)
  issuer_id?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  installments!: number;

  @ValidateNested()
  @Type(() => CardPayerDto)
  payer!: CardPayerDto;

  /** El `MP_DEVICE_SESSION_ID` del SDK: mejora la aprobación. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  device_session_id?: string;

  /** Lo manda el Brick; se ignora (ver arriba). */
  @IsOptional()
  @IsNumber()
  transaction_amount?: number;

  /** Lo manda el Brick en algunas versiones; no se usa. */
  @IsOptional()
  @IsString()
  payment_method_option_id?: string;

  /** Lo manda el Brick en algunas versiones; no se usa. */
  @IsOptional()
  @IsString()
  processing_mode?: string;
}

/** Del formato del Brick al que usa el servicio. */
export function cardInputFrom(dto: CardPaymentDto): CardPaymentInput {
  return {
    token: dto.token,
    paymentMethodId: dto.payment_method_id,
    issuerId: dto.issuer_id ?? null,
    installments: dto.installments,
    payer: {
      email: dto.payer.email,
      identification: dto.payer.identification
        ? {
            type: dto.payer.identification.type,
            number: dto.payer.identification.number,
          }
        : null,
    },
    deviceSessionId: dto.device_session_id ?? null,
  };
}
