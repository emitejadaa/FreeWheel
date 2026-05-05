import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class SubmitIdentityDto {
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  documentUrl!: string;

  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  selfieUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
