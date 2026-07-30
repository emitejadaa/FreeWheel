import { Injectable } from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertFound } from "../common/utils/entity.util";
import { UpdateUserDto } from "./dto/update-user.dto";

type SafeUser = Omit<User, "password">;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async create(data: Prisma.UserCreateInput): Promise<SafeUser> {
    const user = await this.prisma.user.create({ data });

    return this.toSafeUser(user);
  }

  /**
   * Perfil PÚBLICO de una persona: lo que se puede mostrar a otro usuario.
   *
   * Solo nombre, foto, promedio de reseñas y desde cuándo está en la plataforma.
   * Nada de email, teléfono, documento ni fecha de nacimiento: eso no es
   * información pública aunque las dos personas tengan una reserva en curso.
   */
  async getPublicProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        profilePhotoUrl: true,
        ratingAverage: true,
        ratingCount: true,
        verificationStatus: true,
        createdAt: true,
      },
    });
    assertFound(user, "User not found");

    return {
      ...user,
      // Interesa si está verificada o no, no en qué paso del trámite está.
      verified: user.verificationStatus === "VERIFIED",
      verificationStatus: undefined,
    };
  }

  async getMe(userId: string): Promise<SafeUser> {
    const user = await this.findById(userId);
    assertFound(user, "User not found");

    return this.toSafeUser(user);
  }

  async updateMe(userId: string, data: UpdateUserDto): Promise<SafeUser> {
    await this.getMe(userId);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return this.toSafeUser(user);
  }

  toSafeUser(user: User): SafeUser {
    const { password: _password, ...safeUser } = user;

    return safeUser;
  }
}
