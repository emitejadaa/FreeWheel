import { PartialType } from "@nestjs/mapped-types";
import { CreateVehicleDto } from "./create-vehicle.dto";

// Every field of CreateVehicleDto, made optional (validation rules preserved).
export class UpdateVehicleDto extends PartialType(CreateVehicleDto) {}
