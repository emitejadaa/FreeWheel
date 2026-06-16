import { UserStatus } from "@prisma/client";
import { IsEnum } from "class-validator";

export class UpdateUserStatusDto {
  @IsEnum(UserStatus)
  status!: UserStatus;
}
