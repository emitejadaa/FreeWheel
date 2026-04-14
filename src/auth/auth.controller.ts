import { Body, Controller, Post, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CodeResendService } from './code-resend.service';
import { JwtAuthGuard } from './jwt.guard';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { AddMobileDto } from './dto/add-mobile.dto';
import { VerifyMobileDto } from './dto/verify-mobile.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private codeResendService: CodeResendService,
  ) {}

  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(
      registerDto.email,
      registerDto.password,
      registerDto.firstName,
      registerDto.lastName,
      registerDto.birthDate,
    );
  }

  @Post('verify-email')
  verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
    return this.authService.verifyEmail(
      verifyEmailDto.email,
      verifyEmailDto.verificationCode,
    );
  }

  @Post('resend-email-code')
  resendEmailCode(@Body() body: { email: string }) {
    return this.codeResendService.resendEmailVerification(body.email);
  }

  @Post('login')
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto.email, loginDto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Post('add-mobile')
  addMobile(@Body() addMobileDto: AddMobileDto, @Request() req: any) {
    return this.authService.addMobile(req.user.id, addMobileDto.mobile);
  }

  @UseGuards(JwtAuthGuard)
  @Post('verify-mobile')
  verifyMobile(@Body() verifyMobileDto: VerifyMobileDto, @Request() req: any) {
    return this.authService.verifyMobile(req.user.id, verifyMobileDto.verificationCode);
  }

  @UseGuards(JwtAuthGuard)
  @Post('resend-mobile-code')
  resendMobileCode(@Request() req: any) {
    return this.codeResendService.resendMobileVerification(req.user.id);
  }
}