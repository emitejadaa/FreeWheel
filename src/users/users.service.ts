import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Prisma, User, VerificationStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertFound } from "../common/utils/entity.util";
import { dniMatchesCuil, normalizeCuil } from "../common/utils/cuil.util";
import { IdentityReviewService } from "../verification/review/identity-review.service";
import { UpdateUserDto } from "./dto/update-user.dto";

type SafeUser = Omit<User, "password">;

/**
 * Campos que respaldan la identidad verificada: una vez que la cuenta es
 * VERIFIED quedan inmutables (cambiarlos rompería la garantía de que la
 * cuenta pertenece a la persona de los documentos). Un cambio legítimo
 * requiere intervención de un admin.
 */
const IDENTITY_LOCKED_FIELDS = [
  "firstName",
  "lastName",
  "dni",
  "cuil",
  "address",
] as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identityReview: IdentityReviewService,
  ) {}

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
    const current = await this.findById(userId);
    assertFound(current, "User not found");

    const touchedIdentityFields = IDENTITY_LOCKED_FIELDS.filter(
      (field) => data[field] !== undefined,
    );
    if (
      current.verificationStatus === VerificationStatus.VERIFIED &&
      touchedIdentityFields.length > 0
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "IDENTITY_FIELDS_LOCKED",
        message:
          "Tu identidad ya fue verificada: estos campos no pueden modificarse. Contactá a soporte si necesitás corregirlos.",
        fields: touchedIdentityFields,
      });
    }

    const updateData: Prisma.UserUpdateInput = { ...data };
    if (data.cuil !== undefined) {
      // El validador del DTO ya garantizó un CUIL de persona válido.
      updateData.cuil = normalizeCuil(data.cuil) ?? data.cuil;
    }

    // El par (dni, cuil) resultante debe ser consistente: el CUIL embebe el
    // DNI, así que un mismatch es siempre un error de carga.
    const effectiveDni = (updateData.dni as string | undefined) ?? current.dni;
    const effectiveCuil =
      (updateData.cuil as string | undefined) ?? current.cuil;
    if (
      effectiveDni &&
      effectiveCuil &&
      !dniMatchesCuil(effectiveDni, effectiveCuil)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: "CUIL_DNI_MISMATCH",
        message: "El CUIL no corresponde al DNI informado",
      });
    }

    // Pre-chequeo de unicidad para responder un 409 claro; el índice único de
    // la DB sigue cerrando la ventana de carrera.
    await this.assertIdentityUnique(userId, updateData);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    // Completar dni/cuil/address puede ser el último ítem del checklist de
    // verificación: re-evaluar (no-op si falta algo o no hay documentos).
    if (
      data.dni !== undefined ||
      data.cuil !== undefined ||
      data.address !== undefined
    ) {
      await this.identityReview.evaluate(userId);
      const refreshed = await this.findById(userId);
      assertFound(refreshed, "User not found");
      return this.toSafeUser(refreshed);
    }

    return this.toSafeUser(user);
  }

  private async assertIdentityUnique(
    userId: string,
    data: Prisma.UserUpdateInput,
  ): Promise<void> {
    if (typeof data.dni === "string") {
      const clash = await this.prisma.user.findFirst({
        where: { dni: data.dni, id: { not: userId } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException({
          statusCode: 409,
          code: "DNI_ALREADY_REGISTERED",
          message: "Ese DNI ya está asociado a otra cuenta",
        });
      }
    }

    if (typeof data.cuil === "string") {
      const clash = await this.prisma.user.findFirst({
        where: { cuil: data.cuil, id: { not: userId } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException({
          statusCode: 409,
          code: "CUIL_ALREADY_REGISTERED",
          message: "Ese CUIL ya está asociado a otra cuenta",
        });
      }
    }
  }

  toSafeUser(user: User): SafeUser {
    const { password: _password, ...safeUser } = user;

    return safeUser;
  }
}
