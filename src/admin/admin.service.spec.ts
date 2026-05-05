import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import { AuditLogService } from '../common/services/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  let service: AdminService;
  let prisma: {
    user: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: { create: jest.fn() } },
      ],
    }).compile();

    service = module.get(AdminService);
  });

  it('lists users without selecting passwords', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await service.listUsers();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      select: expect.not.objectContaining({ password: true }),
      orderBy: { createdAt: 'desc' },
    });
  });

  it('updates user status with a specific DTO value', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      status: UserStatus.SUSPENDED,
    });

    const result = await service.updateUserStatus(
      'admin-1',
      'user-1',
      UserStatus.SUSPENDED,
    );

    expect(result.status).toBe(UserStatus.SUSPENDED);
  });

  it('updates user role', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      role: UserRole.ADMIN,
    });

    const result = await service.updateUserRole(
      'admin-1',
      'user-1',
      UserRole.ADMIN,
    );

    expect(result.role).toBe(UserRole.ADMIN);
  });
});
