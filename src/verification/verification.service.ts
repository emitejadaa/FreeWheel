import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DocumentVerificationStatus,
  User,
  VerificationCodePurpose,
  VerificationCodeTargetType,
  VerificationStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { SmsService } from "../sms/sms.service";
import { assertFound } from "../common/utils/entity.util";
import { UploadSignatureDto } from "./dto/upload-signature.dto";
import { IdentityDocumentsService } from "./identity/identity-documents.service";
import { DocumentVerificationService } from "./identity/document-verification.service";
import {
  consumeVerificationCode,
  generateNumericCode,
  VERIFICATION_CODE_TTL_MS,
} from "../common/utils/verification-code.util";

type SafeVerificationResponse = {
  requested: true;
  expiresAt: Date;
  /** Canal por el que salió el código: "sms" o "email". */
  channel: "sms" | "email";
  /** A dónde se envió (número o dirección), para mostrarlo en pantalla. */
  sentTo: string;
  /**
   * El código, SOLO en modo demostración (sin pasarela de SMS contratada y con
   * VERIFICATION_CODE_IN_RESPONSE=true). Sirve para poder probar el circuito
   * completo sin depender de que llegue el mail. Con una pasarela real nunca se
   * devuelve.
   */
  code?: string;
};

@Injectable()
export class VerificationService {
  private readonly maxAttempts = 5;
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly identityDocuments: IdentityDocumentsService,
    private readonly documentVerification: DocumentVerificationService,
    private readonly config: ConfigService,
  ) {}

  async requestEmailCode(userId: string): Promise<SafeVerificationResponse> {
    const user = await this.getUser(userId);

    return this.createCode(user, VerificationCodeTargetType.EMAIL, user.email);
  }

  async requestPhoneCode(userId: string): Promise<SafeVerificationResponse> {
    const user = await this.getUser(userId);

    if (!user.phone) {
      throw new BadRequestException(
        "User phone is required before verification",
      );
    }

    return this.createCode(user, VerificationCodeTargetType.PHONE, user.phone);
  }

  async confirmEmailCode(userId: string, code: string) {
    await this.confirmCode(userId, VerificationCodeTargetType.EMAIL, code);

    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
    await this.documentVerification.recomputeAccountStatus(userId);

    return this.getMyStatus(userId);
  }

  async confirmPhoneCode(userId: string, code: string) {
    await this.confirmCode(userId, VerificationCodeTargetType.PHONE, code);

    await this.prisma.user.update({
      where: { id: userId },
      data: { phoneVerifiedAt: new Date() },
    });
    await this.documentVerification.recomputeAccountStatus(userId);

    return this.getMyStatus(userId);
  }

  /**
   * Estado completo para el front: el estado de la cuenta, el checklist
   * derivado y el estado de cada flujo de documento (DNI y licencia por
   * separado). Los motivos vienen en códigos estables + mensajes aptos para
   * mostrar; el detalle de la extracción es dato personal y solo lo ve un
   * admin.
   */
  async getMyStatus(userId: string) {
    const user = await this.getUser(userId);
    const documents = await this.documentVerification.getMyDocuments(userId);

    return {
      verificationStatus: user.verificationStatus,
      fullyVerified: user.verificationStatus === VerificationStatus.VERIFIED,
      checklist: {
        emailVerified: Boolean(user.emailVerifiedAt),
        phoneVerified: Boolean(user.phoneVerifiedAt),
        dateOfBirthProvided: Boolean(user.dateOfBirth),
        identityDataProvided: Boolean(user.dni && user.cuil && user.address),
        dniApproved:
          documents.dni?.status === DocumentVerificationStatus.APPROVED,
        licenseApproved:
          documents.license?.status === DocumentVerificationStatus.APPROVED,
      },
      documents,
      emailVerifiedAt: user.emailVerifiedAt,
      phoneVerifiedAt: user.phoneVerifiedAt,
      // El front necesita saber si el teléfono bloquea o es opcional, y por
      // qué canal va a llegar el código, para explicarlo en pantalla.
      phoneRequired: this.documentVerification.isPhoneVerificationRequired(),
      phoneCodeChannel: this.smsService.isMock ? "email" : "sms",
    };
  }

  /** Firma la subida de un documento de identidad (documento + lado). */
  signIdentityUpload(userId: string, data: UploadSignatureDto) {
    return this.identityDocuments.signUpload(userId, data);
  }

  private async createCode(
    user: User,
    targetType: VerificationCodeTargetType,
    targetValue: string,
  ): Promise<SafeVerificationResponse> {
    const code = generateNumericCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

    await this.prisma.verificationCode.updateMany({
      where: {
        userId: user.id,
        targetType,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });

    await this.prisma.verificationCode.create({
      data: {
        userId: user.id,
        targetType,
        targetValue,
        codeHash,
        expiresAt,
        maxAttempts: this.maxAttempts,
      },
    });

    // ── Entrega del código ──────────────────────────────────────────────
    // El email va por email. El teléfono iría por SMS, pero mandar un SMS a un
    // número real es siempre un servicio pago: mientras no haya una pasarela
    // contratada (SMS_PROVIDER=mock) el código se manda al EMAIL de la persona.
    // Así la verificación del teléfono funciona de verdad y sin costo, y el
    // número queda igual de registrado y confirmado en la base.
    let channel: "sms" | "email" = "email";
    let sentTo = targetValue;

    if (targetType === VerificationCodeTargetType.PHONE) {
      if (this.smsService.isMock) {
        await this.emailService.sendPhoneVerificationCode(
          user.email,
          targetValue,
          code,
        );
        channel = "email";
        sentTo = user.email;
      } else {
        await this.smsService.sendVerificationCode(targetValue, code);
        channel = "sms";
      }
    } else {
      await this.emailService.sendVerificationCode(targetValue, code);
    }

    // Fuera de producción se registra en el log para poder probar a mano.
    if (process.env.NODE_ENV !== "production") {
      this.logger.debug(
        `Verification code for ${targetType} ${targetValue}: ${code}`,
      );
    }

    return {
      requested: true,
      expiresAt,
      channel,
      sentTo,
      // Modo demostración: se devuelve el código para poder completar el
      // circuito sin depender del mail. Requiere no tener pasarela de SMS y
      // VERIFICATION_CODE_IN_RESPONSE=true; con una real, nunca se devuelve.
      ...(this.exposeCodeInResponse ? { code } : {}),
    };
  }

  /**
   * ¿Se puede devolver el código en la respuesta HTTP? Solo con la pasarela de
   * SMS en modo mock y la variable activada a mano. Es una comodidad para la
   * demo, no para una app en producción.
   */
  private get exposeCodeInResponse(): boolean {
    return (
      this.smsService.isMock &&
      (
        this.config.get<string>("VERIFICATION_CODE_IN_RESPONSE") ?? "false"
      ).toLowerCase() === "true"
    );
  }

  private async confirmCode(
    userId: string,
    targetType: VerificationCodeTargetType,
    code: string,
  ) {
    await consumeVerificationCode(this.prisma, {
      // El propósito importa además del canal: el cambio de dirección de email
      // también guarda su código con targetType EMAIL, así que filtrando solo por
      // canal esta confirmación agarraba el código del cambio (el más reciente),
      // no coincidía, y devolvía "código inválido" por un código que estaba bien.
      where: {
        userId,
        targetType,
        purpose: VerificationCodePurpose.EMAIL_VERIFICATION,
      },
      plaintext: code,
      errors: {
        missing: () => new NotFoundException("Verification code not found"),
        expired: () => new BadRequestException("Verification code expired"),
        tooManyAttempts: () =>
          new ForbiddenException("Verification code attempts exceeded"),
        invalid: () => new BadRequestException("Invalid verification code"),
      },
    });
  }

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    assertFound(user, "User not found");

    return user;
  }
}
