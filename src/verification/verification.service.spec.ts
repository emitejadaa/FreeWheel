import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus, VerificationStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationService } from './verification.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

describe('VerificationService', () => {
  let service: VerificationService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    verificationCode: {
      updateMany: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    userVerification: {
      create: jest.Mock;
      findMany: jest.Mock;
    };
  };

  const user = {
    id: 'user-1',
    email: 'user@example.com',
    password: 'hashed',
    firstName: 'Jane',
    lastName: 'Doe',
    displayName: null,
    phone: '+5491112345678',
    profilePhotoUrl: null,
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    verificationStatus: VerificationStatus.UNVERIFIED,
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      verificationCode: {
        updateMany: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      userVerification: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get(VerificationService);
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-code');
  });

  it('creates an email code and returns it outside production', async () => {
    prisma.user.findUnique.mockResolvedValue(user);

    const result = await service.requestEmailCode(user.id);

    expect(prisma.verificationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: user.id,
          targetValue: user.email,
          codeHash: 'hashed-code',
        }),
      }),
    );
    expect(result.code).toHaveLength(6);
  });

  it('fails phone request when user has no phone', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...user, phone: null });

    await expect(service.requestPhoneCode(user.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('confirms email with a valid code', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.verificationCode.findFirst.mockResolvedValue({
      id: 'code-1',
      codeHash: 'hashed-code',
      expiresAt: new Date(Date.now() + 1000),
      attempts: 0,
      maxAttempts: 5,
    });
    prisma.user.update.mockResolvedValue({
      ...user,
      emailVerifiedAt: new Date(),
      verificationStatus: VerificationStatus.EMAIL_VERIFIED,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await service.confirmEmailCode(user.id, '123456');

    expect(result.verificationStatus).toBe(VerificationStatus.EMAIL_VERIFIED);
    expect(prisma.verificationCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('increments attempts on invalid code', async () => {
    prisma.verificationCode.findFirst.mockResolvedValue({
      id: 'code-1',
      codeHash: 'hashed-code',
      expiresAt: new Date(Date.now() + 1000),
      attempts: 0,
      maxAttempts: 5,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(
      service.confirmPhoneCode(user.id, '000000'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.verificationCode.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { attempts: { increment: 1 } },
    });
  });
});
