import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  IdentityDocumentSide,
  IdentityVerificationStatus,
  Prisma,
} from '@prisma/client';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationService } from '../auth/verification.service';
import { UpdatePhoneDto } from './dto/update-phone.dto';
import { VerifyPhoneOtpDto } from './dto/verify-phone-otp.dto';
import { FileStorageService } from '../storage/file-storage.service';

type UploadedIdentityFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verificationService: VerificationService,
    private readonly fileStorageService: FileStorageService,
  ) {}

  async getCurrentUserProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        identityDocuments: {
          select: {
            id: true,
            side: true,
            uploadedAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new BadRequestException('Usuario no encontrado.');
    }

    return {
      data: this.buildProfileResponse(user),
    };
  }

  async updatePhoneNumber(userId: string, updatePhoneDto: UpdatePhoneDto) {
    const phoneNumber = this.normalizePhoneNumber(updatePhoneDto.phoneNumber);
    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        phoneNumber: true,
        identityVerificationStatus: true,
      },
    });

    if (!currentUser) {
      throw new BadRequestException('Usuario no encontrado.');
    }

    const existingPhone = await this.prisma.user.findFirst({
      where: {
        phoneNumber,
        id: { not: userId },
      },
      select: { id: true },
    });

    if (existingPhone) {
      throw new ConflictException('El teléfono ya está asociado a otra cuenta.');
    }

    const phoneChanged = currentUser.phoneNumber !== phoneNumber;
    if (phoneChanged) {
      await this.verificationService.invalidatePhoneVerifications(userId);
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber,
        phoneVerified: currentUser.phoneNumber === phoneNumber ? undefined : false,
        phoneVerifiedAt:
          currentUser.phoneNumber === phoneNumber ? undefined : null,
      },
      include: {
        identityDocuments: {
          select: {
            id: true,
            side: true,
            uploadedAt: true,
          },
        },
      },
    });

    return {
      message: 'Teléfono actualizado correctamente.',
      data: this.buildProfileResponse(user),
    };
  }

  async sendPhoneVerification(userId: string) {
    await this.verificationService.sendPhoneVerificationCode(userId);

    return {
      message: 'Enviamos un código SMS para verificar tu teléfono.',
    };
  }

  async verifyPhone(userId: string, verifyPhoneOtpDto: VerifyPhoneOtpDto) {
    await this.verificationService.verifyPhoneCode(
      userId,
      verifyPhoneOtpDto.code,
    );

    return {
      message: 'Teléfono verificado correctamente.',
      data: await this.getProfileSummary(userId),
    };
  }

  async uploadIdentityDocument(userId: string, file?: UploadedIdentityFile) {
    if (!file) {
      throw new BadRequestException('Debes adjuntar un archivo.');
    }

    this.assertAllowedDocument(file);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        identityVerificationStatus: true,
      },
    });

    if (!user) {
      throw new BadRequestException('Usuario no encontrado.');
    }

    if (user.identityVerificationStatus === IdentityVerificationStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        'Tu verificación de identidad ya está pendiente de revisión.',
      );
    }

    if (user.identityVerificationStatus === IdentityVerificationStatus.VERIFIED) {
      throw new BadRequestException(
        'La cuenta ya fue verificada. El reemplazo de documentos requiere revisión manual.',
      );
    }

    const storedFile = await this.fileStorageService.savePrivateFile({
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalFilename: file.originalname,
      folder: `identity-documents/${userId}`,
    });

    const existingDocument = await this.prisma.userDocument.findUnique({
      where: {
        userId_side: {
          userId,
          side: IdentityDocumentSide.FRONT,
        },
      },
    });

    if (existingDocument) {
      await this.fileStorageService.deleteFile(existingDocument.storageKey);
    }

    await this.prisma.$transaction([
      this.prisma.userDocument.upsert({
        where: {
          userId_side: {
            userId,
            side: IdentityDocumentSide.FRONT,
          },
        },
        update: {
          storageKey: storedFile.storageKey,
          mimeType: storedFile.mimeType,
          originalFilename: storedFile.originalFilename,
          fileSize: storedFile.fileSize,
          uploadedAt: new Date(),
        },
        create: {
          userId,
          side: IdentityDocumentSide.FRONT,
          storageKey: storedFile.storageKey,
          mimeType: storedFile.mimeType,
          originalFilename: storedFile.originalFilename,
          fileSize: storedFile.fileSize,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          identityVerificationStatus:
            user.identityVerificationStatus === IdentityVerificationStatus.REJECTED
              ? IdentityVerificationStatus.UNVERIFIED
              : user.identityVerificationStatus,
          identityVerificationRequestedAt:
            user.identityVerificationStatus === IdentityVerificationStatus.REJECTED
              ? null
              : undefined,
          identityVerificationRejectedAt:
            user.identityVerificationStatus === IdentityVerificationStatus.REJECTED
              ? null
              : undefined,
          identityVerificationReviewedAt:
            user.identityVerificationStatus === IdentityVerificationStatus.REJECTED
              ? null
              : undefined,
          identityVerificationRejectionReason:
            user.identityVerificationStatus === IdentityVerificationStatus.REJECTED
              ? null
              : undefined,
        },
      }),
    ]);

    return {
      message: 'Documento cargado correctamente.',
      data: await this.getProfileSummary(userId),
    };
  }

  async requestIdentityVerification(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        identityDocuments: {
          select: { id: true },
        },
      },
    });

    if (!user) {
      throw new BadRequestException('Usuario no encontrado.');
    }

    if (!user.emailVerified) {
      throw new BadRequestException('Debes verificar tu email primero.');
    }

    if (!user.phoneVerified) {
      throw new BadRequestException('Debes verificar tu teléfono primero.');
    }

    if (user.identityDocuments.length === 0) {
      throw new BadRequestException('Debes subir un documento de identidad.');
    }

    if (user.identityVerificationStatus === IdentityVerificationStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        'Tu cuenta ya está pendiente de revisión.',
      );
    }

    if (user.identityVerificationStatus === IdentityVerificationStatus.VERIFIED) {
      throw new BadRequestException('Tu cuenta ya está verificada.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        identityVerificationStatus: IdentityVerificationStatus.PENDING_REVIEW,
        identityVerificationRequestedAt: new Date(),
        identityVerificationRejectedAt: null,
        identityVerificationReviewedAt: null,
        identityVerificationRejectionReason: null,
      },
    });

    return {
      message: 'Tu verificación de identidad quedó pendiente de revisión.',
      data: await this.getProfileSummary(userId),
    };
  }

  private async getProfileSummary(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        identityDocuments: {
          select: {
            id: true,
            side: true,
            uploadedAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new BadRequestException('Usuario no encontrado.');
    }

    return this.buildProfileResponse(user);
  }

  private buildProfileResponse(
    user: Prisma.UserGetPayload<{
      include: {
        identityDocuments: {
          select: {
            id: true;
            side: true;
            uploadedAt: true;
          };
        };
      };
    }>,
  ) {
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      emailVerifiedAt: user.emailVerifiedAt,
      phoneNumber: user.phoneNumber,
      phoneVerified: user.phoneVerified,
      phoneVerifiedAt: user.phoneVerifiedAt,
      identityVerificationStatus: user.identityVerificationStatus,
      identityVerificationRequestedAt: user.identityVerificationRequestedAt,
      identityVerifiedAt: user.identityVerifiedAt,
      identityVerificationRejectedAt: user.identityVerificationRejectedAt,
      identityVerificationRejectionReason: user.identityVerificationRejectionReason,
      hasUploadedIdentityDocument: user.identityDocuments.length > 0,
      uploadedIdentityDocuments: user.identityDocuments,
      isFullyVerified:
        user.identityVerificationStatus === IdentityVerificationStatus.VERIFIED,
    };
  }

  private normalizePhoneNumber(phoneNumber: string) {
    return phoneNumber.replace(/[^\d+]/g, '');
  }

  private assertAllowedDocument(file: UploadedIdentityFile) {
    const allowedMimeTypes = (process.env.IDENTITY_DOCUMENT_ALLOWED_MIME_TYPES ??
      'image/jpeg,image/png,image/webp').split(',');

    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Tipo de archivo no permitido.');
    }

    const extension = extname(file.originalname).toLowerCase();
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];

    if (extension && !allowedExtensions.includes(extension)) {
      throw new BadRequestException('Extensión de archivo no permitida.');
    }
  }
}
