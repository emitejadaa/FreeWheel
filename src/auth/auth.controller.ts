import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { OnboardingAuthGuard } from "./guards/onboarding-auth.guard";
import { GoogleAuthGuard } from "./guards/google-auth.guard";
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

/**
 * LOS LÍMITES DE ESTE CONTROLADOR NO SON POR COSTO.
 *
 * El tope general del servidor es de 120 pedidos por minuto y por IP, que para
 * una pantalla de login es una invitación: 120 contraseñas por minuto son
 * 172.800 por día contra una sola cuenta, y eso alcanza para cualquier
 * contraseña que una persona pueda recordar.
 *
 * Lo mismo con los códigos de seis dígitos: son un millón de combinaciones, y
 * aunque cada código tiene su propio contador de intentos, sin un tope por IP
 * alguien puede pedir códigos nuevos y probar contra todos a la vez.
 *
 * Y con "olvidé mi contraseña": sin límite, es una forma de averiguar qué
 * direcciones tienen cuenta y de llenarle la casilla a alguien.
 *
 * Los números están elegidos para que una persona real no los toque nunca. Diez
 * intentos de login en cinco minutos es alguien que de verdad no se acuerda;
 * el undécimo es un programa.
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  /** Step 1: email only — sends the verification code. No account yet. */
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post("register/start")
  registerStart(@Body() dto: RegisterStartDto) {
    return this.authService.registerStart(dto);
  }

  /** Step 2: code + full payload — creates the (email-verified) account. */
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Post("register/complete")
  registerComplete(@Body() dto: RegisterCompleteDto) {
    return this.authService.registerComplete(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @UseGuards(OnboardingAuthGuard)
  @Post("verify-email")
  verifyEmail(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: VerifyEmailDto,
  ) {
    return this.authService.verifyEmail(user.id, dto);
  }

  @Throttle({ default: { limit: 5, ttl: 900_000 } })
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

  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post("forgot-password")
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Post("reset-password")
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  /*
    GoogleAuthGuard en vez de AuthGuard("google") pelado.

    Hace lo mismo, y además contesta algo entendible cuando el servidor no tiene
    cargadas las credenciales de Google. Sin credenciales la estrategia no se
    registra (ver auth.module.ts, y está bien que sea así: passport revienta al
    construirse sin ellas y se llevaría puesta la aplicación entera), pero
    entonces passport tiraba `Unknown authentication strategy "google"` y al
    navegador le llegaba un "Internal server error" pelado. Una situación
    prevista mostrada como si el servidor se hubiera roto.
  */
  @Get("google")
  @UseGuards(GoogleAuthGuard)
  googleAuth() {
    // Passport redirige a Google automáticamente
  }

  @Get("google/callback")
  @UseGuards(GoogleAuthGuard)
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
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @UseGuards(JwtAuthGuard)
  @Post("request-email-change")
  requestEmailChange(@Req() req: Request, @Body() dto: RequestEmailChangeDto) {
    return this.authService.requestEmailChange(
      (req.user as CurrentUserPayload).id,
      dto.newEmail,
    );
  }

  @Throttle({ default: { limit: 10, ttl: 900_000 } })
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
