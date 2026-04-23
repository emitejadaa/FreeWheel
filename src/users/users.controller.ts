import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { UsersService } from './users.service';
import { UpdatePhoneDto } from './dto/update-phone.dto';
import { VerifyPhoneOtpDto } from './dto/verify-phone-otp.dto';

type UploadedIdentityFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  getMe(@Request() req: { user: { id: string } }) {
    return this.usersService.getCurrentUserProfile(req.user.id);
  }

  @Get('me/verification-status')
  getVerificationStatus(@Request() req: { user: { id: string } }) {
    return this.usersService.getCurrentUserProfile(req.user.id);
  }

  @Patch('me/phone')
  updatePhone(
    @Request() req: { user: { id: string } },
    @Body() updatePhoneDto: UpdatePhoneDto,
  ) {
    return this.usersService.updatePhoneNumber(req.user.id, updatePhoneDto);
  }

  @Post('me/phone/send-verification')
  sendPhoneVerification(@Request() req: { user: { id: string } }) {
    return this.usersService.sendPhoneVerification(req.user.id);
  }

  @Post('me/phone/verify')
  verifyPhone(
    @Request() req: { user: { id: string } },
    @Body() verifyPhoneOtpDto: VerifyPhoneOtpDto,
  ) {
    return this.usersService.verifyPhone(req.user.id, verifyPhoneOtpDto);
  }

  @Post('me/identity/document')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize:
          Number(process.env.IDENTITY_DOCUMENT_MAX_FILE_SIZE_MB ?? '5') *
          1024 *
          1024,
      },
    }),
  )
  uploadIdentityDocument(
    @Request() req: { user: { id: string } },
    @UploadedFile() file: UploadedIdentityFile,
  ) {
    return this.usersService.uploadIdentityDocument(req.user.id, file);
  }

  @Post('me/identity/request-verification')
  requestIdentityVerification(@Request() req: { user: { id: string } }) {
    return this.usersService.requestIdentityVerification(req.user.id);
  }
}
