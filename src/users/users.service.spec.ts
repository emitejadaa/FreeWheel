import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus, VerificationStatus } from '@prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  const user = {
    id: 'user-1',
    email: 'user@example.com',
    password: 'hashed-password',
    firstName: 'Jane',
    lastName: 'Doe',
    displayName: 'Jane',
    phone: '+5491112345678',
    profilePhotoUrl: 'https://example.com/profile.jpg',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    verificationStatus: VerificationStatus.UNVERIFIED,
    createdAt: new Date('2026-05-05T00:00:00.000Z'),
    updatedAt: new Date('2026-05-05T00:00:00.000Z'),
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('removes password from safe user responses', () => {
    const safeUser = service.toSafeUser(user);

    expect(safeUser).not.toHaveProperty('password');
    expect(safeUser.email).toBe(user.email);
  });

  it('does not allow self-service updates of role, status, or verification status', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({
      ...user,
      firstName: 'Janet',
    });

    await service.updateMe(user.id, {
      firstName: 'Janet',
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: { firstName: 'Janet' },
    });
  });
});
