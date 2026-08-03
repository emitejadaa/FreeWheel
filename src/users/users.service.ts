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
   *
   * Del documento se devuelve ÚNICAMENTE los últimos cuatro dígitos, y solo si la
   * cuenta está verificada. Alcanza para lo que sirve —darle a la otra persona
   * algo concreto que mirar, y poder cotejarlo si alguna vez hay un problema— sin
   * poner el número entero ni las fotos del DNI a la vista de cualquiera, que es
   * material con el que se suplanta una identidad. Las fotos completas las ven el
   * propio dueño de la cuenta (GET /verification/identity/me) y el panel de
   * administración (GET /admin/verifications), y nadie más.
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

    const verified = user.verificationStatus === "VERIFIED";

    // Los últimos cuatro dígitos del documento con el que se verificó. Se lee de
    // la última solicitud aprobada, no de lo que la persona haya escrito.
    let documentLast4: string | null = null;
    if (verified) {
      const approved = await this.prisma.userVerification.findFirst({
        where: { userId, status: "VERIFIED", documentNumber: { not: null } },
        orderBy: { reviewedAt: "desc" },
        select: { documentNumber: true },
      });
      const digits = (approved?.documentNumber ?? "").replace(/\D/g, "");
      if (digits.length >= 4) documentLast4 = digits.slice(-4);
    }

    return {
      ...user,
      // Interesa si está verificada o no, no en qué paso del trámite está.
      verified,
      documentLast4,
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
