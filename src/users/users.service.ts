import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Prisma, User, VerificationStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertFound } from "../common/utils/entity.util";
import { dniMatchesCuil, normalizeCuil } from "../common/utils/cuil.util";
import { normalizeEmail } from "../common/utils/email.util";
import {
  identityConflict,
  identityConflictFromPrisma,
  UniqueIdentityField,
} from "../common/utils/account-identity.util";
import { DocumentVerificationService } from "../verification/identity/document-verification.service";
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
    private readonly documentVerification: DocumentVerificationService,
  ) {}

  /**
   * Busca por email SIEMPRE por la forma canónica (minúsculas, sin espacios al
   * borde), que es la única que se guarda. Sin esto, escribir la dirección con
   * una mayúscula al iniciar sesión o al recuperar la contraseña daba "no existe
   * esa cuenta" sobre una cuenta que sí existe.
   */
  async findByEmail(email: string) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    return this.prisma.user.findUnique({ where: { email: normalized } });
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
        // Lo lee PhotoVisibilityInterceptor para decidir si la foto se muestra;
        // no llega al front (el interceptor saca el campo de la respuesta).
        profilePhotoVisibility: true,
        ratingAverage: true,
        ratingCount: true,
        verificationStatus: true,
        createdAt: true,
      },
    });
    assertFound(user, "User not found");

    const verified = user.verificationStatus === "VERIFIED";

    // Los últimos cuatro dígitos del documento con el que se verificó. Se leen
    // del DNI aprobado, no de lo que la persona haya escrito.
    let documentLast4: string | null = null;
    if (verified) {
      const approved = await this.prisma.documentVerification.findFirst({
        where: {
          userId,
          type: "DNI",
          status: "APPROVED",
          documentNumber: { not: null },
        },
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
    // Con la cuenta VERIFIED —o con al menos UN documento ya aprobado contra
    // estos datos— la identidad queda inmutable: cambiarla invalidaría la
    // comparación que aprobó el documento.
    if (
      touchedIdentityFields.length > 0 &&
      (current.verificationStatus === VerificationStatus.VERIFIED ||
        (await this.documentVerification.hasApprovedDocument(userId)))
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
    //
    // El teléfono entró acá junto con el DNI y el CUIL: hasta ahora cualquiera
    // podía poner en su perfil el número de otra persona, y con ese número
    // pedirse el código de verificación.
    await this.assertIdentityUnique(
      {
        phone: updateData.phone as string | undefined,
        dni: updateData.dni as string | undefined,
        cuil: updateData.cuil as string | undefined,
      },
      userId,
    );

    const user = await this.withIdentityConflicts(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      }),
    );

    return this.toSafeUser(user);
  }

  /**
   * Que ninguno de los datos que identifican a una persona quede repartido entre
   * dos cuentas.
   *
   * Es un PRE-chequeo: existe para contestar un 409 que dice qué dato está
   * repetido, no para garantizar la unicidad. La garantía la dan los índices
   * únicos de la base —email (también sin mirar mayúsculas), phone, dni, cuil y
   * googleId—, que son los que cierran la ventana entre esta consulta y la
   * escritura si dos requests llegan a la vez. De ese caso se ocupa
   * `identityConflictFromPrisma`, que traduce el choque al MISMO 409.
   *
   * `exceptUserId` es la cuenta que se está editando: sus propios valores no
   * cuentan como repetidos.
   */
  async assertIdentityUnique(
    values: Partial<Record<UniqueIdentityField, string | null | undefined>>,
    exceptUserId?: string,
  ): Promise<void> {
    for (const [field, value] of Object.entries(values) as [
      UniqueIdentityField,
      string | null | undefined,
    ][]) {
      if (typeof value !== "string" || value.length === 0) continue;

      const clash = await this.prisma.user.findFirst({
        where: {
          [field]: value,
          ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
        },
        select: { id: true },
      });
      if (clash) throw identityConflict(field);
    }
  }

  /**
   * Corre una escritura sobre User traduciendo el choque de un índice único al
   * 409 que le corresponde al dato repetido. Cualquier otro error sale tal cual.
   */
  async withIdentityConflicts<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const conflict = identityConflictFromPrisma(error);
      if (conflict) throw conflict;
      throw error;
    }
  }

  toSafeUser(user: User): SafeUser {
    const { password: _password, ...safeUser } = user;

    return safeUser;
  }
}
