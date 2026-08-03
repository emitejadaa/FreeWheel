import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { OnboardingAuthGuard } from "./guards/onboarding-auth.guard";
import { LoginDto } from "./dto/login.dto";
import { RegisterStartDto } from "./dto/register-start.dto";
import { RegisterCompleteDto } from "./dto/register-complete.dto";
import { CompleteProfileDto } from "./dto/complete-profile.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import {
  ConfirmEmailChangeDto,
  RequestEmailChangeDto,
} from "./dto/email-change.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { getFrontendUrl } from "../config/public-urls";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import type { CurrentUserPayload } from "../common/types/current-user.type";
import type { GoogleProfilePayload } from "./strategies/google.strategy";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  /** Step 1: email only — sends the verification code. No account yet. */
  @Post("register/start")
  registerStart(@Body() dto: RegisterStartDto) {
    return this.authService.registerStart(dto);
  }

  /** Step 2: code + full payload — creates the (email-verified) account. */
  @Post("register/complete")
  registerComplete(@Body() dto: RegisterCompleteDto) {
    return this.authService.registerComplete(dto);
  }

  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @UseGuards(OnboardingAuthGuard)
  @Post("verify-email")
  verifyEmail(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: VerifyEmailDto,
  ) {
    return this.authService.verifyEmail(user.id, dto);
  }

  @UseGuards(OnboardingAuthGuard)
  @Post("resend-verification")
  resendVerification(@CurrentUser() user: CurrentUserPayload) {
    return this.authService.sendVerificationEmail(user.id, user.email);
  }

  /** Mandatory profile data (date of birth, 18+) for Google/legacy accounts. */
  @UseGuards(OnboardingAuthGuard)
  @Post("complete-profile")
  completeProfile(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CompleteProfileDto,
  ) {
    return this.authService.completeProfile(user.id, dto);
  }

  @Post("forgot-password")
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post("reset-password")
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Get("google")
  @UseGuards(AuthGuard("google"))
  googleAuth() {
    // Passport redirige a Google automáticamente
  }

  @Get("google/callback")
  @UseGuards(AuthGuard("google"))
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const result = await this.authService.googleLogin(
      req.user as GoogleProfilePayload,
    );
    const frontendUrl = getFrontendUrl(this.configService);
    // Accounts without a date of birth only get an onboarding token; the
    // frontend must show the complete-profile form before anything else.
    if ("onboardingToken" in result) {
      res.redirect(
        `${frontendUrl}/auth/google/callback?token=${result.onboardingToken}&pending=complete_profile`,
      );
      return;
    }
    res.redirect(
      `${frontendUrl}/auth/google/callback?token=${result.accessToken}`,
    );
  }

  /**
   * Cambiar el email de la cuenta, en dos pasos. El código va a la dirección
   * NUEVA: es la única forma de comprobar que existe y es de quien la pone.
   * Hasta confirmar, el email de la cuenta no se toca.
   */
  @UseGuards(JwtAuthGuard)
  @Post("request-email-change")
  requestEmailChange(@Req() req: Request, @Body() dto: RequestEmailChangeDto) {
    return this.authService.requestEmailChange(
      (req.user as CurrentUserPayload).id,
      dto.newEmail,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post("confirm-email-change")
  confirmEmailChange(@Req() req: Request, @Body() dto: ConfirmEmailChangeDto) {
    // La dirección sale del código guardado, no del cuerpo del pedido.
    return this.authService.confirmEmailChange(
      (req.user as CurrentUserPayload).id,
      dto.code,
    );
  }
}
