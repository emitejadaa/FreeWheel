import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, UserStatus } from '@prisma/client';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let reflector: jest.Mocked<Reflector>;
  let guard: RolesGuard;

  function contextWithUser(user?: unknown): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;
    guard = new RolesGuard(reflector);
  });

  it('allows routes without role metadata', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(guard.canActivate(contextWithUser())).toBe(true);
  });

  it('rejects missing user for admin routes', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);

    expect(guard.canActivate(contextWithUser())).toBe(false);
  });

  it('rejects USER for admin routes', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);

    expect(
      guard.canActivate(
        contextWithUser({
          id: 'user-1',
          email: 'user@example.com',
          role: UserRole.USER,
          status: UserStatus.ACTIVE,
        }),
      ),
    ).toBe(false);
  });

  it('allows active ADMIN for admin routes', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.ADMIN]);

    expect(
      guard.canActivate(
        contextWithUser({
          id: 'admin-1',
          email: 'admin@example.com',
          role: UserRole.ADMIN,
          status: UserStatus.ACTIVE,
        }),
      ),
    ).toBe(true);
  });
});
