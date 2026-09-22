import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { SignOptions } from "jsonwebtoken";
import { createHash } from "crypto";
import {
  User,
  UserStatus,
  VerificationCodePurpose,
  VerificationStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { LoginDto } from "./dto/login.dto";
import { RegisterStartDto } from "./dto/register-start.dto";
import { RegisterCompleteDto } from "./dto/register-complete.dto";
import { CompleteProfileDto } from "./dto/complete-profile.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { DocumentVerificationService } from "../verification/identity/document-verification.service";
import { GoogleProfilePayload } from "./strategies/google.strategy";
import { PASSWORD_HASH_COST } from "./dto/password-policy";
import { AuditLogService } from "../common/services/audit-log.service";
import { RateLimitService } from "../common/rate-limit/rate-limit.service";
import { assertFound } from "../common/utils/entity.util";
import { normalizeEmail } from "../common/utils/email.util";
import {
  consumeVerificationCode,
  generateNumericCode,
  generateOpaqueToken,
  VERIFICATION_CODE_TTL_MS,
} from "../common/utils/verification-code.util";

// Enumeration-safe reply: identical whether or not the email belongs to a user.
const PASSWORD_RESET_REPLY = "If that email exists, we sent you a link.";

/**
 * Un hash de bcrypt contra el que comparar cuando el mail no existe.
 *
 * No es la contraseña de nadie: es el hash de una cadena aleatoria que nadie
 * conoce, y lo único que se busca es que comparar contra él CUESTE lo mismo
 * que comparar contra el hash de una cuenta real. Ver el uso en `login`.
 *
 * Tiene que tener el MISMO costo que las contraseñas (PASSWORD_HASH_COST). Si
 * las cuentas reales comparan a costo 12 y esto a costo 10, la diferencia de
 * tiempo vuelve a existir —ahora al revés: el mail inexistente contesta 4
 * veces más rápido— y el login vuelve a decir qué direcciones tienen cuenta.
 */
const HASH_DE_DESCARTE =
  "$2b$12$KWTxuqeCth6ki02l9pqsYOI2YsQ6cwSvJm9DYxJxsA2Lhp4M4wToi";

/**
 * EL BLOQUEO POR CUENTA: cinco contraseñas mal seguidas traban el login con
 * contraseña de ESA cuenta por quince minutos.
 *
 * Complementa al límite por IP, que no alcanza solo: frena a uno que prueba
 * muchas cuentas desde un lugar, pero no a muchos lugares probando una cuenta,
 * que es exactamente lo que hace una botnet contra un objetivo elegido. Este
 * cuenta contra la cuenta, y cambiar de IP no lo resetea.
 *
 * El precio conocido es que cualquiera puede trabarle el login a otra persona
 * errando cinco veces a propósito. Por eso es corto, por eso no se estira con
 * cada intento, y por eso tiene dos salidas que no dependen de esperar:
 * recuperar la contraseña lo levanta en el momento, y entrar con Google no pasa
 * por acá.
 */
const MAX_INTENTOS_FALLIDOS = 5;
const BLOQUEO_DE_LOGIN_MS = 15 * 60 * 1000;

/**
 * Cuántos mails puede disparar un anónimo hacia UNA MISMA casilla por hora,
 * sumando todas las IPs.
 *
 * El límite por IP de las rutas no alcanza para esto: repartido entre muchas
 * IPs, "olvidé mi contraseña" o "registrarme" le llenan la casilla a alguien
 * con mails nuestros, y el que queda como spammer somos nosotros.
 */
const MAILS_POR_CASILLA_POR_HORA = 5;

/**
 * La respuesta a un login que no pasa, SEA POR LO QUE SEA.
 *
 * Mail inexistente, contraseña equivocada y cuenta trabada contestan
 * exactamente esto, y tardan lo mismo. Si cualquiera de los tres se
 * distinguiera, el login le diría a quien pregunta qué direcciones tienen
 * cuenta —o peor, cuáles están siendo atacadas en este momento—.
 */
function credencialesInvalidas(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: "INVALID_CREDENTIALS",
    message: "El email o la contraseña no son correctos.",
  });
}

/**
 * La casilla como parte de una clave de contador, sin guardarla legible.
 *
 * La tabla de contadores no tiene por qué ser una lista de direcciones de
 * email: con el hash alcanza para contar, y quien lea la tabla no se lleva
 * nada.
 */
function claveDeCasilla(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 32);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly documentVerification: DocumentVerificationService,
    private readonly configService: ConfigService,
    private readonly auditLog: AuditLogService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Step 1 of registration: send a verification code to an email that has no
   * account yet. No User row exists until the code is confirmed in
   * registerComplete. Re-calling rotates the code (doubles as "resend").
   */
  async registerStart(dto: RegisterStartDto) {
    // El email se canoniza acá y no solo en el DTO: la dirección con la que se
    // guarda la registración pendiente tiene que ser LA MISMA con la que después
    // la busca registerComplete, o el código no se encuentra nunca.
    const email = normalizeEmail(dto.email);
    if (!email) throw new BadRequestException("Email inválido");

    const existing = await this.usersService.findByEmail(email);
    if (existing) throw new ConflictException("Email already registered");

    // Acá SÍ se puede contestar 429: esta ruta ya dice si el mail tiene cuenta
    // (el 409 de arriba), así que decir que la casilla recibió demasiados
    // códigos no revela nada nuevo.
    const porCasilla = await this.rateLimit.hit(
      `auth.register.start:email:${claveDeCasilla(email)}`,
      MAILS_POR_CASILLA_POR_HORA,
      60 * 60,
    );
    if (!porCasilla.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: "RATE_LIMITED",
          message:
            "Ya te mandamos varios códigos a esta dirección. Buscá el último " +
            "en tu casilla (también en spam) o esperá un rato para pedir otro.",
          retryAfterSec: porCasilla.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateNumericCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

    await this.prisma.pendingRegistration.upsert({
      where: { email },
      update: { codeHash, expiresAt, attempts: 0, consumedAt: null },
      create: { email, codeHash, expiresAt },
    });

    await this.emailService.sendVerificationCode(email, code);
    this.logger.log(`Registration code sent to ${email}`);

    return { message: "Verification code sent", expiresAt };
  }

  /**
   * Step 2 of registration: the email code plus the full registration payload.
   * Only here is the User created — already email-verified — inside one
   * transaction that also deletes the pending registration.
   */
  async registerComplete(dto: RegisterCompleteDto) {
    const email = normalizeEmail(dto.email);
    if (!email) throw new BadRequestException("Email inválido");

    const existing = await this.usersService.findByEmail(email);
    if (existing) throw new ConflictException("Email already registered");

    // El teléfono también identifica a una cuenta, así que se mira ANTES de
    // gastar el código: antes se podía registrar una cuenta nueva con el número
    // de otra persona, que es con lo que se verifica la identidad.
    await this.usersService.assertIdentityUnique({ phone: dto.phone });

    await this.consumePendingRegistrationCode(email, dto.code);

    const password = await bcrypt.hash(dto.password, PASSWORD_HASH_COST);
    const now = new Date();

    const user = await this.usersService.withIdentityConflicts(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            password,
            firstName: dto.firstName,
            lastName: dto.lastName,
            displayName: dto.displayName,
            phone: dto.phone,
            dateOfBirth: parseBirthDate(dto.dateOfBirth),
            acceptedTermsAt: now,
            status: UserStatus.ACTIVE,
            verificationStatus: VerificationStatus.EMAIL_VERIFIED,
            emailVerifiedAt: now,
            passwordChangedAt: now,
          },
        });
        await tx.pendingRegistration.delete({ where: { email } });
        return created;
      }),
    );

    this.logger.log(`User registered: ${user.email} (${user.id})`);

    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
    };
  }

  async login(loginDto: LoginDto) {
    const user = await this.usersService.findByEmail(loginDto.email);

    if (!user) {
      this.logger.warn(`Login failed (unknown email): ${loginDto.email}`);
      // Se compara contra un hash de descarte ANTES de contestar.
      //
      // Sin esto, un mail que no existe contestaba enseguida y uno que sí
      // existe tardaba lo que tarda bcrypt. Esa diferencia es medible desde
      // afuera y convierte la pantalla de login en una lista de qué
      // direcciones tienen cuenta acá — que es el primer paso de cualquier
      // campaña de phishing dirigida. El costo es ese mismo tiempo sobre un
      // pedido que ya va a fallar.
      await bcrypt.compare(loginDto.password, HASH_DE_DESCARTE);
      throw credencialesInvalidas();
    }

    // Con la cuenta trabada NO se mira la contraseña: ni siquiera la correcta
    // entra. Si la correcta entrara, el bloqueo no frenaría nada —el atacante
    // seguiría probando y la acertada le abriría la puerta igual—.
    //
    // Pero se compara igual contra el hash de descarte, y se contesta lo
    // mismo que a una contraseña equivocada. Una respuesta más rápida o
    // distinta acá le diría a quien prueba que la cuenta existe y que alguien
    // la está atacando.
    if (user.loginLockedUntil && user.loginLockedUntil > new Date()) {
      this.logger.warn(
        `Login rejected (locked until ${user.loginLockedUntil.toISOString()}): ${user.email}`,
      );
      await bcrypt.compare(loginDto.password, HASH_DE_DESCARTE);
      throw credencialesInvalidas();
    }

    const ok = await bcrypt.compare(loginDto.password, user.password);
    if (!ok) {
      await this.registrarLoginFallido(user);
      throw credencialesInvalidas();
    }

    await this.registrarLoginCorrecto(user, loginDto.password);

    // El estado de la cuenta se mira DESPUÉS de la contraseña, y no antes
    // como se hacía. Antes, cualquiera que escribiera un mail podía saber si
    // esa cuenta existía y estaba suspendida sin saber la contraseña; ahora
    // eso solo lo sabe quien la sabe, que es el dueño.
    if (
      user.status === UserStatus.SUSPENDED ||
      user.status === UserStatus.DELETED
    ) {
      this.logger.warn(`Login blocked (status ${user.status}): ${user.email}`);
      throw new UnauthorizedException({
        statusCode: 401,
        // El front lo traduce y explica qué pasó. Sin el código tendría que
        // reconocer la frase en inglés, que se rompe el día que alguien la
        // reescribe: la persona veía "Account is not active" tal cual, en una
        // app en castellano y sin ninguna pista de por qué no entra.
        code: "ACCOUNT_NOT_ACTIVE",
        message: "Account is not active",
      });
    }

    // Legacy accounts created before email-first registration: no session until
    // the email is verified. A fresh code is sent and a short-lived onboarding
    // token (only valid on the onboarding endpoints) lets them finish.
    if (!user.emailVerifiedAt) {
      await this.sendVerificationEmail(user.id, user.email);
      this.logger.log(`Login pending email verification: ${user.email}`);
      return {
        user: this.usersService.toSafeUser(user),
        emailVerificationRequired: true,
        onboardingToken: this.signOnboardingToken(user.id, user.email),
      };
    }

    // Date of birth is mandatory for everyone (18+); legacy and Google accounts
    // without one must complete their profile before getting a full session.
    if (!user.dateOfBirth) {
      this.logger.log(`Login pending profile completion: ${user.email}`);
      return {
        user: this.usersService.toSafeUser(user),
        profileCompletionRequired: true,
        onboardingToken: this.signOnboardingToken(user.id, user.email),
      };
    }

    this.logger.log(`User logged in: ${user.email}`);
    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
    };
  }

  async sendVerificationEmail(userId: string, email: string) {
    await this.prisma.verificationCode.updateMany({
      where: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    const code = generateNumericCode();
    const codeHash = await bcrypt.hash(code, 10);

    await this.prisma.verificationCode.create({
      data: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        targetType: "EMAIL",
        targetValue: email,
        codeHash,
        expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
      },
    });

    await this.emailService.sendVerificationCode(email, code);
    return { message: "Verification code sent" };
  }

  /** Legacy-account email verification (new registrations verify pre-creation). */
  async verifyEmail(userId: string, dto: VerifyEmailDto) {
    let user = await this.usersService.findById(userId);
    assertFound(user, "User not found");

    if (!user.emailVerifiedAt) {
      await consumeVerificationCode(this.prisma, {
        where: {
          userId,
          purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
        },
        plaintext: dto.code,
        errors: {
          missing: () =>
            new BadRequestException("Code expired. Request a new one."),
          expired: () =>
            new BadRequestException("Code expired. Request a new one."),
          tooManyAttempts: () =>
            new BadRequestException("Too many attempts. Request a new code."),
          invalid: () => new BadRequestException("Incorrect code"),
        },
      });

      user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          emailVerifiedAt: new Date(),
          verificationStatus:
            user.verificationStatus === VerificationStatus.UNVERIFIED
              ? VerificationStatus.EMAIL_VERIFIED
              : user.verificationStatus,
        },
      });

      await this.documentVerification.recomputeAccountStatus(userId);
      this.logger.log(`Email verified for user ${userId}`);
    }

    // Hand out the next step: a full session if the profile is complete, or an
    // onboarding token so the user can provide their date of birth.
    if (!user.dateOfBirth) {
      return {
        message: "Email verified successfully",
        profileCompletionRequired: true,
        onboardingToken: this.signOnboardingToken(user.id, user.email),
      };
    }

    return {
      message: "Email verified successfully",
      accessToken: this.signToken(user.id, user.email),
    };
  }

  /**
   * Completes the mandatory profile data (date of birth, 18+) for accounts
   * created without it (Google sign-in, legacy). Immutable once set.
   */
  async completeProfile(userId: string, dto: CompleteProfileDto) {
    let user = await this.usersService.findById(userId);
    assertFound(user, "User not found");

    if (!user.emailVerifiedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "EMAIL_NOT_VERIFIED",
        message: "Verificá tu email antes de completar el perfil",
        emailVerificationRequired: true,
      });
    }

    if (!user.dateOfBirth) {
      user = await this.prisma.user.update({
        where: { id: userId },
        data: { dateOfBirth: parseBirthDate(dto.dateOfBirth) },
      });

      await this.documentVerification.recomputeAccountStatus(userId);
      this.logger.log(`Profile completed (dateOfBirth) for user ${userId}`);
    }

    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
    };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    this.logger.log(`Password reset requested for ${dto.email}`);

    // Se corta ACÁ, antes de buscar el usuario, y no cuando se manda el mail: si
    // el corte quedara más abajo, un email registrado daría 503 y uno inexistente
    // daría el mensaje genérico, y comparando las dos respuestas se podría
    // averiguar qué direcciones tienen cuenta.
    if (!this.emailService.configured) {
      throw new ServiceUnavailableException(
        "No podemos enviar mails en este momento, así que no te llegaría el " +
          "link para recuperar la contraseña. Avisale a quien administra el " +
          "servidor que falta configurar el envío de mails.",
      );
    }

    const user = await this.usersService.findByEmail(dto.email);
    if (!user) return { message: PASSWORD_RESET_REPLY };

    // Pasado el tope por casilla se contesta LO MISMO y no se manda nada. Un
    // 429 acá diría "esta dirección tiene cuenta" —a las que no tienen no les
    // mandamos nada, así que nunca llegan al tope—, que es justo lo que la
    // respuesta genérica existe para no decir.
    const porCasilla = await this.rateLimit.hit(
      `auth.forgot-password:email:${claveDeCasilla(user.email)}`,
      MAILS_POR_CASILLA_POR_HORA,
      60 * 60,
    );
    if (!porCasilla.allowed) {
      this.logger.warn(
        `Password reset not sent (too many for this mailbox): ${user.email}`,
      );
      return { message: PASSWORD_RESET_REPLY };
    }

    await this.prisma.verificationCode.updateMany({
      where: {
        userId: user.id,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    const token = generateOpaqueToken(32);
    const tokenHash = await bcrypt.hash(token, 10);

    await this.prisma.verificationCode.create({
      data: {
        userId: user.id,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
        targetType: "EMAIL",
        targetValue: user.email,
        codeHash: tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await this.emailService.sendPasswordReset(
      user.email,
      user.firstName,
      token,
      user.id,
    );

    return { message: PASSWORD_RESET_REPLY };
  }

  async resetPassword(dto: ResetPasswordDto) {
    await consumeVerificationCode(this.prisma, {
      where: {
        userId: dto.userId,
        purpose: VerificationCodePurpose.PASSWORD_RESET,
      },
      plaintext: dto.token,
      errors: {
        missing: () =>
          new BadRequestException("This link has expired or is invalid."),
        expired: () =>
          new BadRequestException("This link has expired or is invalid."),
        tooManyAttempts: () =>
          new BadRequestException(
            "Invalid link. Request a new recovery email.",
          ),
        invalid: () => new BadRequestException("This link is invalid."),
      },
    });

    await this.prisma.user.update({
      where: { id: dto.userId },
      data: {
        password: await bcrypt.hash(dto.newPassword, PASSWORD_HASH_COST),
        // Todas las sesiones abiertas de antes de este momento dejan de valer
        // (ver session-revocation.ts). Es el punto de recuperar la contraseña
        // después de un robo: que el que la robó quede afuera, no solo que
        // no pueda volver a entrar.
        passwordChangedAt: new Date(),
        // Y el bloqueo por intentos se levanta: quien recuperó la contraseña
        // demostró que el mail es suyo, que es más de lo que demuestra
        // esperar quince minutos. Es la salida para la persona a la que le
        // trabaron el login a propósito.
        failedLoginAttempts: 0,
        loginLockedUntil: null,
      },
    });

    await this.auditLog.create({
      targetUserId: dto.userId,
      action: "auth.password.reset",
      entityType: "User",
      entityId: dto.userId,
    });

    this.logger.log(`Password reset completed for user ${dto.userId}`);
    return { message: "Password updated successfully." };
  }

  async googleLogin(googleUser: GoogleProfilePayload) {
    const email = normalizeEmail(googleUser.email);
    if (!email) throw new BadRequestException("Email inválido");

    let user = await this.usersService.findByEmail(email);

    // Una cuenta suspendida o dada de baja no entra por ningún lado.
    //
    // Esto FALTABA: `login` lo miraba y este camino no, así que a una cuenta
    // baneada le alcanzaba con tocar "Entrar con Google" para volver a estar
    // adentro. Una suspensión que se esquiva con un botón no es una suspensión.
    if (
      user &&
      (user.status === UserStatus.SUSPENDED ||
        user.status === UserStatus.DELETED)
    ) {
      this.logger.warn(
        `Google login blocked (status ${user.status}): ${user.email}`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        // El front lo traduce y explica qué pasó. Sin el código tendría que
        // reconocer la frase en inglés, que se rompe el día que alguien la
        // reescribe: la persona veía "Account is not active" tal cual, en una
        // app en castellano y sin ninguna pista de por qué no entra.
        code: "ACCOUNT_NOT_ACTIVE",
        message: "Account is not active",
      });
    }

    if (!user) {
      // Una contraseña que nadie conoce, con el mismo costo que las demás: así
      // todas las cuentas cuestan lo mismo de comparar en el login, que es de
      // lo que depende que el tiempo de respuesta no distinga cuentas.
      const randomPassword = await bcrypt.hash(
        generateOpaqueToken(32),
        PASSWORD_HASH_COST,
      );
      user = await this.usersService.withIdentityConflicts(() =>
        this.prisma.user.create({
          data: {
            email,
            password: randomPassword,
            passwordChangedAt: new Date(),
            firstName: googleUser.firstName,
            lastName: googleUser.lastName,
            googleId: googleUser.googleId,
            profilePhotoUrl: googleUser.profilePhotoUrl ?? null,
            verificationStatus: VerificationStatus.EMAIL_VERIFIED,
            emailVerifiedAt: new Date(),
          },
        }),
      );
    } else if (!user.googleId) {
      const cuenta = user;
      user = await this.usersService.withIdentityConflicts(() =>
        this.prisma.user.update({
          where: { id: cuenta.id },
          data: {
            googleId: googleUser.googleId,
            verificationStatus:
              cuenta.verificationStatus === VerificationStatus.UNVERIFIED
                ? VerificationStatus.EMAIL_VERIFIED
                : cuenta.verificationStatus,
            emailVerifiedAt: cuenta.emailVerifiedAt ?? new Date(),
          },
        }),
      );
    }

    this.logger.log(`Google login for ${user.email}`);

    // Google does not provide a birth date: until the user completes it (18+)
    // they only get an onboarding token, never a full session.
    if (!user.dateOfBirth) {
      return {
        user: this.usersService.toSafeUser(user),
        profileCompletionRequired: true as const,
        onboardingToken: this.signOnboardingToken(user.id, user.email),
      };
    }

    return {
      user: this.usersService.toSafeUser(user),
      accessToken: this.signToken(user.id, user.email),
    };
  }

  /**
   * Primer paso para cambiar el email de la cuenta: se manda un código A LA
   * DIRECCIÓN NUEVA.
   *
   * Va a la nueva y no a la vieja a propósito: lo que hay que probar es que esa
   * dirección existe y es de quien la está poniendo. El email es la llave de la
   * cuenta —por ahí llega el link para recuperar la contraseña—, así que dejarla
   * apuntando a una dirección mal escrita sería perder el acceso.
   *
   * El email de la cuenta NO se toca acá: queda guardado en el código y se aplica
   * al confirmar.
   */
  async requestEmailChange(userId: string, newEmailRaw: string) {
    const newEmail = normalizeEmail(newEmailRaw);
    if (!newEmail) throw new BadRequestException("Email inválido");

    const user = await this.usersService.findById(userId);
    if (user && user.email === newEmail) {
      throw new BadRequestException(
        "Ese ya es el email de tu cuenta. Poné una dirección distinta.",
      );
    }

    const existing = await this.usersService.findByEmail(newEmail);
    if (existing) {
      throw new ConflictException(
        "Ya hay una cuenta con ese email. Probá con otra dirección.",
      );
    }

    // Se anulan los pedidos de cambio anteriores, y SOLO esos. Antes esto usaba
    // el propósito EMAIL_VERIFICATION, el mismo que el código para confirmar el
    // email actual: los dos trámites se pisaban, y confirmar la verificación
    // agarraba el código del cambio (el más reciente) y contestaba "código
    // inválido" por un código que estaba bien.
    await this.prisma.verificationCode.updateMany({
      where: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_CHANGE,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    const code = generateNumericCode();
    const codeHash = await bcrypt.hash(code, 10);

    await this.prisma.verificationCode.create({
      data: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_CHANGE,
        targetType: "EMAIL",
        targetValue: newEmail,
        codeHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    await this.emailService.sendVerificationCode(newEmail, code);
    this.logger.log(`Email change requested for user ${userId}`);
    return { message: "Code sent to the new email.", sentTo: newEmail };
  }

  /**
   * Segundo paso: con el código que llegó a la dirección nueva, se aplica el
   * cambio.
   *
   * La dirección se toma DEL CÓDIGO GUARDADO, no de lo que manda el cliente: así
   * no hay forma de confirmar con un código válido y colar otra dirección.
   */
  async confirmEmailChange(userId: string, code: string) {
    const record = await consumeVerificationCode(this.prisma, {
      where: {
        userId,
        purpose: VerificationCodePurpose.EMAIL_CHANGE,
      },
      plaintext: code,
      errors: {
        missing: () =>
          new BadRequestException(
            "No hay ningún cambio de email pendiente. Volvé a pedir el código.",
          ),
        expired: () =>
          new BadRequestException("El código venció. Pedí uno nuevo."),
        tooManyAttempts: () =>
          new BadRequestException("Demasiados intentos. Pedí un código nuevo."),
        invalid: () => new BadRequestException("El código no es correcto."),
      },
    });

    // Se vuelve a canonizar aunque requestEmailChange ya lo hizo: un código
    // pedido ANTES de este cambio tiene guardada la dirección tal cual la
    // escribió la persona, y aplicarla así dejaría el email de la cuenta con
    // mayúsculas —que es exactamente lo que la base ya no acepta—.
    const newEmail = normalizeEmail(record.targetValue) ?? record.targetValue;

    // Se vuelve a chequear: entre el pedido y la confirmación pasan minutos y
    // alguien podría haber registrado esa dirección.
    const existing = await this.usersService.findByEmail(newEmail);
    if (existing && existing.id !== userId) {
      throw new ConflictException(
        "Mientras confirmabas, alguien registró ese email. Probá con otra dirección.",
      );
    }

    await this.usersService.withIdentityConflicts(() =>
      this.prisma.user.update({
        where: { id: userId },
        data: {
          email: newEmail,
          // Se acaba de comprobar que recibe el correo ahí, así que la
          // dirección nueva queda verificada. Antes no se tocaba, y la cuenta se
          // quedaba con la marca de verificación de la dirección ANTERIOR.
          emailVerifiedAt: new Date(),
        },
      }),
    );

    this.logger.log(`Email changed for user ${userId}`);
    return { message: "Email updated successfully." };
  }

  /**
   * Una contraseña equivocada sobre una cuenta que existe.
   *
   * El contador sube con un `increment` atómico y no leyendo y escribiendo:
   * cinco intentos simultáneos tienen que contar cinco, no uno.
   *
   * Al llegar al tope, el bloqueo se escribe con un `updateMany`
   * condicionado a que la cuenta NO esté ya trabada. Con intentos en paralelo
   * varios pueden ver el contador en 5 a la vez; solo uno gana esa escritura, y
   * es el único que manda el aviso. Si no, un ataque con paralelismo le
   * llenaría la casilla al dueño con el mismo mail.
   *
   * Al trabarla el contador vuelve a cero, así que cuando el bloqueo vence hay
   * otros cinco intentos. Sin eso, después de un bloqueo cada error volvería a
   * trabarla al instante, y una persona que se equivoca una vez más quedaría
   * afuera otros quince minutos por un solo error.
   */
  private async registrarLoginFallido(user: User): Promise<void> {
    const { failedLoginAttempts } = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    this.logger.warn(
      `Login failed (bad password, ${failedLoginAttempts}/${MAX_INTENTOS_FALLIDOS}): ${user.email}`,
    );
    if (failedLoginAttempts < MAX_INTENTOS_FALLIDOS) return;

    const ahora = new Date();
    const lockedUntil = new Date(ahora.getTime() + BLOQUEO_DE_LOGIN_MS);
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: user.id,
        failedLoginAttempts: { gte: MAX_INTENTOS_FALLIDOS },
        OR: [{ loginLockedUntil: null }, { loginLockedUntil: { lte: ahora } }],
      },
      data: { loginLockedUntil: lockedUntil, failedLoginAttempts: 0 },
    });
    if (count === 0) return;

    this.logger.warn(
      `Login locked until ${lockedUntil.toISOString()}: ${user.email}`,
    );
    await this.auditLog.create({
      targetUserId: user.id,
      action: "auth.login.locked",
      entityType: "User",
      entityId: user.id,
      metadata: { lockedUntil: lockedUntil.toISOString() },
    });

    // El aviso no puede tumbar la respuesta: si el mail falla, el login
    // contesta el mismo 401 de siempre. Un 500 o un 503 acá sería la única
    // respuesta distinta de todo el flujo, y justo en el intento que traba
    // la cuenta.
    try {
      await this.emailService.sendSecurityAlert(user.email, {
        recipientName: user.firstName,
        kind: "LOGIN_LOCKED",
        lockedUntil,
      });
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `No se pudo avisar el bloqueo a ${user.email}: ${detalle}`,
      );
    }
  }

  /**
   * La contraseña fue correcta: se limpia el contador y, si el hash es de
   * antes de subir el costo, se reescribe.
   *
   * Reescribirlo acá es la única forma de migrar los hashes viejos sin pedirle
   * a nadie que cambie la contraseña: es el único momento en que tenemos la
   * contraseña en texto plano. NO toca `passwordChangedAt`: la contraseña es
   * la misma, y cerrarle las demás sesiones a alguien porque cambiamos cómo la
   * guardamos sería un castigo por nada.
   *
   * Solo se escribe si hay algo que cambiar, para no sumar una escritura a
   * cada login.
   */
  private async registrarLoginCorrecto(
    user: User,
    password: string,
  ): Promise<void> {
    const data: {
      failedLoginAttempts?: number;
      loginLockedUntil?: null;
      password?: string;
    } = {};
    if (user.failedLoginAttempts > 0 || user.loginLockedUntil) {
      data.failedLoginAttempts = 0;
      data.loginLockedUntil = null;
    }
    if (costoDelHash(user.password) < PASSWORD_HASH_COST) {
      data.password = await bcrypt.hash(password, PASSWORD_HASH_COST);
    }
    if (Object.keys(data).length === 0) return;

    await this.prisma.user.update({ where: { id: user.id }, data });
  }

  /**
   * Same find → expiry → attempts → compare sequence as consumeVerificationCode
   * (src/common/utils/verification-code.util.ts), but against the
   * PendingRegistration table, which has no userId. The row is not marked
   * consumed here — registerComplete deletes it in the user-creation
   * transaction, so a failure after this point still allows a retry.
   */
  private async consumePendingRegistrationCode(email: string, code: string) {
    const pending = await this.prisma.pendingRegistration.findUnique({
      where: { email },
    });

    if (!pending || pending.consumedAt) {
      throw new BadRequestException("Code expired. Request a new one.");
    }
    if (pending.expiresAt <= new Date()) {
      throw new BadRequestException("Code expired. Request a new one.");
    }
    if (pending.attempts >= pending.maxAttempts) {
      throw new BadRequestException("Too many attempts. Request a new code.");
    }

    const matches = await bcrypt.compare(code, pending.codeHash);
    if (!matches) {
      await this.prisma.pendingRegistration.update({
        where: { id: pending.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException("Incorrect code");
    }
  }

  private signToken(userId: string, email: string) {
    return this.jwtService.sign({ email }, { subject: userId });
  }

  /**
   * Short-lived token scoped to the onboarding endpoints only (JwtStrategy
   * rejects it everywhere else). Issued when a user still owes email
   * verification or their date of birth.
   */
  private signOnboardingToken(userId: string, email: string) {
    const expiresIn =
      this.configService.get<string>("ONBOARDING_JWT_EXPIRES_IN") ?? "30m";
    return this.jwtService.sign(
      { email, scope: "onboarding" },
      { subject: userId, expiresIn: expiresIn as SignOptions["expiresIn"] },
    );
  }
}

/**
 * El costo con el que se generó un hash de bcrypt. Un hash que no se puede
 * leer cuenta como de costo máximo, así nunca se intenta "mejorarlo".
 */
function costoDelHash(hash: string): number {
  try {
    return bcrypt.getRounds(hash);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** DTO-validated YYYY-MM-DD string → Date at UTC midnight. */
function parseBirthDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
