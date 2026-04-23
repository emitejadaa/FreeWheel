import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  } as any;
  const verificationService = {
    issueEmailVerification: jest.fn(),
    consumeEmailVerificationToken: jest.fn(),
    resendEmailVerification: jest.fn(),
  } as any;
  const tokenService = {
    generateAccessToken: jest.fn(),
    createRefreshToken: jest.fn(),
    rotateRefreshToken: jest.fn(),
    revokeRefreshToken: jest.fn(),
  } as any;

  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthService(prisma, verificationService, tokenService);
  });

  it('registers a user and triggers email verification', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      emailVerified: false,
      phoneNumber: null,
      phoneVerified: false,
      identityVerificationStatus: 'UNVERIFIED',
    });

    const response = await service.register({
      email: 'TEST@example.com',
      password: 'Password1',
      firstName: 'Test',
      lastName: 'User',
      birthDate: '1990-01-01',
    });

    expect(prisma.user.create).toHaveBeenCalled();
    expect(verificationService.issueEmailVerification).toHaveBeenCalledWith(
      'user-1',
      'test@example.com',
    );
    expect(response.data.user.emailVerified).toBe(false);
  });

  it('rejects duplicate emails on register', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

    await expect(
      service.register({
        email: 'test@example.com',
        password: 'Password1',
        firstName: 'Test',
        lastName: 'User',
        birthDate: '1990-01-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('logs in with valid credentials', async () => {
    const bcrypt = require('bcrypt') as typeof import('bcrypt');
    const passwordHash = await bcrypt.hash('Password1', 4);

    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      passwordHash,
      emailVerified: false,
      phoneNumber: null,
      phoneVerified: false,
      identityVerificationStatus: 'UNVERIFIED',
    });
    tokenService.generateAccessToken.mockReturnValue('access-token');
    tokenService.createRefreshToken.mockResolvedValue('refresh-token');

    const response = await service.login({
      email: 'test@example.com',
      password: 'Password1',
    });

    expect(response.data.accessToken).toBe('access-token');
    expect(response.data.refreshToken).toBe('refresh-token');
  });

  it('rejects invalid credentials on login', async () => {
    const bcrypt = require('bcrypt') as typeof import('bcrypt');
    const passwordHash = await bcrypt.hash('Password1', 4);

    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      passwordHash,
    });

    await expect(
      service.login({
        email: 'test@example.com',
        password: 'wrong',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('verifies email by token', async () => {
    verificationService.consumeEmailVerificationToken.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      emailVerified: true,
      phoneNumber: null,
      phoneVerified: false,
      identityVerificationStatus: 'UNVERIFIED',
    });

    const response = await service.verifyEmail('token-value');
    expect(response.data.user.emailVerified).toBe(true);
  });
});
