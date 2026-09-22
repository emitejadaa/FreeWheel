import { VehicleHolderRelation } from "@prisma/client";
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from "class-validator";

/**
 * Una fecha de documento: `YYYY-MM-DD` y nada más. Lo que dice una póliza o una
 * oblea de VTV es un DÍA, y aceptar un instante con hora y zona dejaba que la
 * misma fecha entrara corrida según desde dónde se cargara.
 */
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAJE_FECHA = "debe ser una fecha en formato YYYY-MM-DD";

/**
 * LO QUE SE ENVÍA PARA VERIFICAR QUE UN AUTO ES DE QUIEN LO PUBLICA: las dos
 * fotos de la cédula y lo que el dueño lee de ella y de su póliza.
 *
 * El formato de la patente, del chasis y del DNI NO se valida acá sino en el
 * servicio, y es a propósito: un 400 de class-validator trae un `message` en
 * inglés y ningún `code`, y el front necesita saber si el problema fue la
 * patente (INVALID_PLATE) o el chasis (INVALID_CHASSIS) para marcar el campo
 * exacto. Acá solo se controla que cada cosa sea del tipo correcto y no mida
 * cualquier cosa.
 *
 * `insuranceCoversRental` es opcional en el DTO por la misma razón: si falta o
 * es false, la respuesta tiene que ser la misma —INSURANCE_MUST_COVER_RENTAL—
 * y no un 400 genérico cuando falta y uno con código cuando es false.
 */
export class SubmitVehicleVerificationDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  cedulaFrontUrl!: string;

  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  cedulaBackUrl!: string;

  /** Como figura en la cédula: "AB 123 CD", "ABC-123"… se normaliza al guardar. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  plate!: string;

  /** Número de chasis (VIN) de 17 caracteres, como figura en la cédula. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  chassisNumber!: string;

  @IsEnum(VehicleHolderRelation)
  holderRelation!: VehicleHolderRelation;

  /** Nombre del titular tal como figura en la cédula. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  holderName!: string;

  /** DNI del titular, con o sin puntos. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  holderDni!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  insurerName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  insurancePolicyNumber!: string;

  @IsString()
  @Matches(FECHA, { message: `insuranceExpiresAt ${MENSAJE_FECHA}` })
  insuranceExpiresAt!: string;

  /**
   * Si la póliza cubre el uso para alquiler. Una póliza de uso particular
   * suele excluir el alquiler: sin esta cobertura, lo más probable es que la
   * aseguradora rechace cualquier siniestro ocurrido durante una reserva.
   */
  @IsOptional()
  @IsBoolean()
  insuranceCoversRental?: boolean;

  /** Vencimiento de la VTV, si el auto la tiene (los nuevos no la necesitan). */
  @IsOptional()
  @IsString()
  @Matches(FECHA, { message: `vtvExpiresAt ${MENSAJE_FECHA}` })
  vtvExpiresAt?: string;
}
