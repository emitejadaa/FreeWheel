import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { UnauthorizedException } from "@nestjs/common";
import { UserRole, UserStatus, VerificationStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";

jest.mock("bcryptjs", () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));

describe("AuthService", () => {
  let service: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let jwtService: jest.Mocked<JwtService>;

  const user = {
    id: "user-1",
    email: "user@example.com",
    password: "hashed-password",
    firstName: "Jane",
    lastName: "Doe",
    displayName: null,
    phone: null,
    profilePhotoUrl: null,
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    verificationStatus: VerificationStatus.UNVERIFIED,
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            create: jest.fn(),
            toSafeUser: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: EmailService,
          useValue: {
            sendVerificationCode: jest.fn(),
            sendPasswordReset: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    usersService = module.get(UsersService);
    jwtService = module.get(JwtService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("does not return password when login succeeds", async () => {
    usersService.findByEmail.mockResolvedValue(user);
    const { password: _password, ...safeUser } = user;
    usersService.toSafeUser.mockReturnValue(safeUser);
    jwtService.sign.mockReturnValue("access-token");
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await service.login({
      email: "user@example.com",
      password: "secret123",
    });

    expect(result.accessToken).toBe("access-token");
    expect(result.user).not.toHaveProperty("password");
  });

  it("rejects suspended users during login", async () => {
    usersService.findByEmail.mockResolvedValue({
      ...user,
      status: UserStatus.SUSPENDED,
    });

    await expect(
      service.login({ email: "user@example.com", password: "secret123" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
