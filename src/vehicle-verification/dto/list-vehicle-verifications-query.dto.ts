import { VehicleVerificationStatus } from "@prisma/client";
import { IsEnum, IsOptional } from "class-validator";

export class ListVehicleVerificationsQueryDto {
  @IsOptional()
  @IsEnum(VehicleVerificationStatus)
  status?: VehicleVerificationStatus;
}
