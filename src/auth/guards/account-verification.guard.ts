import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import {
  VERIFICATION_REQUIREMENTS_KEY,
  VerificationRequirements,
} from '../decorators/verification-requirements.decorator';

@Injectable()
export class AccountVerificationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const requirements = this.reflector.getAllAndOverride<VerificationRequirements>(
      VERIFICATION_REQUIREMENTS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requirements) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id as string | undefined;

    if (!userId) {
      throw new ForbiddenException('Usuario no autenticado.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        emailVerified: true,
        phoneVerified: true,
        identityVerificationStatus: true,
      },
    });

    if (!user) {
      throw new ForbiddenException('Usuario no encontrado.');
    }

    if (requirements.emailVerified && !user.emailVerified) {
      throw new ForbiddenException('Debes verificar tu email para continuar.');
    }

    if (requirements.phoneVerified && !user.phoneVerified) {
      throw new ForbiddenException('Debes verificar tu teléfono para continuar.');
    }

    if (
      requirements.identityStatuses &&
      !requirements.identityStatuses.includes(user.identityVerificationStatus)
    ) {
      throw new ForbiddenException(
        'Tu cuenta no cumple con el estado de verificación requerido.',
      );
    }

    return true;
  }
}
