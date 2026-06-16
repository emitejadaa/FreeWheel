import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class SignUploadDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-zA-Z0-9_\-/]+$/, {
    message: "folder solo admite letras, números, guiones y barras",
  })
  folder?: string;
}
