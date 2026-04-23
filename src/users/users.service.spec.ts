import { BadRequestException, ConflictException } from '@nestjs/common';
import { IdentityVerificationStatus } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    userDocument: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(async (operations: any[]) => Promise.all(operations)),
  } as any;
  const verificationService = {
    invalidatePhoneVerifications: jest.fn(),
    sendPhoneVerificationCode: jest.fn(),
    verifyPhoneCode: jest.fn(),
  } as any;
  const fileStorageService = {
    savePrivateFile: jest.fn(),
    deleteFile: jest.fn(),
  } as any;

  let service: UsersService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UsersService(prisma, verificationService, fileStorageService);
  });

  it('returns user profile summary', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      phoneNumber: '+5491111111111',
      phoneVerified: true,
      phoneVerifiedAt: new Date(),
      identityVerificationStatus: IdentityVerificationStatus.PENDING_REVIEW,
      identityVerificationRequestedAt: new Date(),
      identityVerifiedAt: null,
      identityVerificationRejectedAt: null,
      identityVerificationRejectionReason: null,
      identityDocuments: [{ id: 'doc-1', side: 'FRONT', uploadedAt: new Date() }],
    });

    const response = await service.getCurrentUserProfile('user-1');
    expect(response.data.hasUploadedIdentityDocument).toBe(true);
  });

  it('updates phone number and clears verification when changed', async () => {
    prisma.user.findUnique.mockResolvedValue({
      phoneNumber: '+5491100000000',
      identityVerificationStatus: IdentityVerificationStatus.UNVERIFIED,
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      emailVerified: false,
      emailVerifiedAt: null,
      phoneNumber: '+5491111111111',
      phoneVerified: false,
      phoneVerifiedAt: null,
      identityVerificationStatus: IdentityVerificationStatus.UNVERIFIED,
      identityVerificationRequestedAt: null,
      identityVerifiedAt: null,
      identityVerificationRejectedAt: null,
      identityVerificationRejectionReason: null,
      identityDocuments: [],
    });

    const response = await service.updatePhoneNumber('user-1', {
      phoneNumber: '+5491111111111',
    });

    expect(verificationService.invalidatePhoneVerifications).toHaveBeenCalledWith(
      'user-1',
    );
    expect(response.data.phoneVerified).toBe(false);
  });

  it('rejects duplicate phone number', async () => {
    prisma.user.findUnique.mockResolvedValue({
      phoneNumber: null,
      identityVerificationStatus: IdentityVerificationStatus.UNVERIFIED,
    });
    prisma.user.findFirst.mockResolvedValue({ id: 'other-user' });

    await expect(
      service.updatePhoneNumber('user-1', { phoneNumber: '+5491111111111' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requests identity verification only when preconditions are met', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        emailVerified: true,
        phoneVerified: true,
        identityVerificationStatus: IdentityVerificationStatus.UNVERIFIED,
        identityDocuments: [{ id: 'doc-1' }],
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        email: 'test@example.com',
        emailVerified: true,
        emailVerifiedAt: new Date(),
        phoneNumber: '+5491111111111',
        phoneVerified: true,
        phoneVerifiedAt: new Date(),
        identityVerificationStatus: IdentityVerificationStatus.PENDING_REVIEW,
        identityVerificationRequestedAt: new Date(),
        identityVerifiedAt: null,
        identityVerificationRejectedAt: null,
        identityVerificationRejectionReason: null,
        identityDocuments: [{ id: 'doc-1', side: 'FRONT', uploadedAt: new Date() }],
      });
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
    });

    const response = await service.requestIdentityVerification('user-1');
    expect(prisma.user.update).toHaveBeenCalled();
    expect(response.data.identityVerificationStatus).toBe(
      IdentityVerificationStatus.PENDING_REVIEW,
    );
  });

  it('rejects identity verification without uploaded document', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      emailVerified: true,
      phoneVerified: true,
      identityVerificationStatus: IdentityVerificationStatus.UNVERIFIED,
      identityDocuments: [],
    });

    await expect(
      service.requestIdentityVerification('user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
