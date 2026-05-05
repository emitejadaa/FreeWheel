import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../common/types/current-user.type';
import { ConfirmCodeDto } from './dto/confirm-code.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { VerificationService } from './verification.service';

@Controller('verification')
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Post('email/request')
  requestEmail(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.requestEmailCode(user.id);
  }

  @Post('email/confirm')
  confirmEmail(
    @CurrentUser() user: CurrentUserPayload,
    @Body() confirmCodeDto: ConfirmCodeDto,
  ) {
    return this.verificationService.confirmEmailCode(
      user.id,
      confirmCodeDto.code,
    );
  }

  @Post('phone/request')
  requestPhone(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.requestPhoneCode(user.id);
  }

  @Post('phone/confirm')
  confirmPhone(
    @CurrentUser() user: CurrentUserPayload,
    @Body() confirmCodeDto: ConfirmCodeDto,
  ) {
    return this.verificationService.confirmPhoneCode(
      user.id,
      confirmCodeDto.code,
    );
  }

  @Get('me/status')
  getStatus(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.getMyStatus(user.id);
  }

  @Post('identity/submit')
  submitIdentity(
    @CurrentUser() user: CurrentUserPayload,
    @Body() submitIdentityDto: SubmitIdentityDto,
  ) {
    return this.verificationService.submitIdentity(user.id, submitIdentityDto);
  }

  @Get('identity/me')
  getMyIdentity(@CurrentUser() user: CurrentUserPayload) {
    return this.verificationService.getMyIdentity(user.id);
  }
}
