import { IsAdultDate } from "../../common/validators/is-adult-date.validator";

export class CompleteProfileDto {
  /** Birth date as YYYY-MM-DD; only adults (18+) may use the platform. */
  @IsAdultDate()
  dateOfBirth!: string;
}
