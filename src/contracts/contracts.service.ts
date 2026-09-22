import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BookingStatus,
  Contract,
  ContractStatus,
  Prisma,
} from "@prisma/client";
import { createHash } from "crypto";
import PDFDocument from "pdfkit";
import { AuditLogService } from "../common/services/audit-log.service";
import { EncryptionService } from "../common/crypto/encryption.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { PrismaService } from "../prisma/prisma.service";
import { buildTicket, Ticket } from "../payments/money/ticket";
import {
  buildClauses,
  Clause,
  ClausePolicy,
  CONTRACT_CLAUSES_VERSION,
} from "./contract-clauses";

const BOOKING_INCLUDE = {
  owner: true,
  renter: true,
  vehicle: true,
  listing: true,
} satisfies Prisma.BookingInclude;

/** Estados en los que el contrato todavía se puede aceptar. */
const ACEPTABLE: BookingStatus[] = [
  BookingStatus.ACCEPTED,
  BookingStatus.READY_FOR_PICKUP,
];

export type ContractRole = "OWNER" | "RENTER";

export interface AcceptanceContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** El contenido del contrato: lo que se hashea y lo que cada parte acepta. */
export interface ContractContent {
  version: string;
  bookingId: string;
  parties: {
    owner: { name: string; dni: string | null };
    renter: { name: string; dni: string | null };
  };
  vehicle: { description: string; plate: string | null };
  period: { startDate: string; endDate: string; days: number };
  ticket: Ticket;
  policy: ClausePolicy;
  clauses: Clause[];
}

/**
 * EL CONTRATO DE UNA RESERVA, Y LA PRUEBA DE QUE CADA PARTE LO ACEPTÓ.
 *
 * La firma por click es válida (Ley 25.506), pero si una parte la desconoce,
 * probarla le toca a quien la invoca. Todo este servicio está armado para
 * poder probarla:
 *
 *   · QUÉ se aceptó: el contenido canónico y su hash SHA-256.
 *   · QUE NO CAMBIÓ: después de la primera aceptación el contenido queda fijo
 *     (lockedAt). Antes, aceptar una reserva regeneraba el contrato y pisaba
 *     los términos, así que una aceptación vieja podía quedar apuntando a un
 *     texto que ya no era el que la persona había visto.
 *   · QUIÉN, CUÁNDO y DESDE DÓNDE: cada aceptación es una fila aparte, con el
 *     hash de lo que se aceptó, la hora, la cuenta (verificada con DNI) y la IP
 *     y el navegador cifrados.
 *   · EL DOCUMENTO: el PDF se genera una vez y se guarda con su hash. Antes se
 *     regeneraba en cada descarga, y cambiar el código del PDF cambiaba un
 *     contrato ya firmado.
 */
@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
  ) {}

  /** Los números de la política que las cláusulas mencionan. */
  policy(): ClausePolicy {
    const numero = (clave: string, defecto: number) => {
      const valor = Number.parseFloat(this.config.get<string>(clave) ?? "");
      return Number.isFinite(valor) && valor >= 0 ? valor : defecto;
    };
    return {
      withdrawalDays: numero("CONSUMER_WITHDRAWAL_DAYS", 10),
      inspectionHours: numero("DAMAGE_REPORT_WINDOW_HOURS", 48),
      claimResponseHours: numero("DAMAGE_CLAIM_RESPONSE_HOURS", 48),
      senaPercent: Math.round(numero("SENA_PCT", 0.3) * 100),
    };
  }

  /** Las cláusulas vigentes, para mostrarlas antes de aceptar una reserva. */
  template() {
    const policy = this.policy();
    return {
      version: CONTRACT_CLAUSES_VERSION,
      pendingLegalReview: true,
      policy,
      clauses: buildClauses(policy),
    };
  }

  /**
   * Crea el contrato de una reserva, o lo regenera SI NADIE LO ACEPTÓ TODAVÍA.
   *
   * Una vez aceptado por una de las partes, no se toca más: se devuelve tal
   * cual. Es la garantía central de todo esto.
   */
  async ensureForBooking(bookingId: string): Promise<Contract> {
    const existente = await this.prisma.contract.findUnique({
      where: { bookingId },
    });
    if (existente && this.isLocked(existente)) {
      return this.lockLegacyIfNeeded(existente);
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: BOOKING_INCLUDE,
    });
    assertFound(booking, "Booking not found");

    const content = this.buildContent(booking);
    const contentHash = hashContent(content);
    const pdfBytes = await this.renderContentPdf(content, contentHash);
    const data = {
      status: ContractStatus.PENDING_ACCEPTANCE,
      terms: content as unknown as Prisma.InputJsonValue,
      version: content.version,
      contentHash,
      pdfBytes: new Uint8Array(pdfBytes),
      pdfHash: sha256(pdfBytes),
      pdfUrl: `/contracts/bookings/${bookingId}/pdf`,
    };

    const contract = existente
      ? await this.prisma.contract.update({ where: { bookingId }, data })
      : await this.prisma.contract.create({ data: { bookingId, ...data } });

    await this.auditLog.create({
      actorId: booking.ownerId,
      targetUserId: booking.renterId,
      action: existente ? "contract.regenerated" : "contract.created",
      entityType: "Booking",
      entityId: bookingId,
      metadata: {
        contractId: contract.id,
        contentHash,
        version: content.version,
      },
    });

    return contract;
  }

  /** Mantiene el nombre viejo para quien lo llamaba. */
  createForBooking(bookingId: string): Promise<Contract> {
    return this.ensureForBooking(bookingId);
  }

  async getForParticipant(userId: string, bookingId: string) {
    const booking = await this.participantBooking(userId, bookingId);
    const contract = await this.prisma.contract.findUnique({
      where: { bookingId },
      include: { acceptances: { orderBy: { acceptedAt: "asc" } } },
    });
    assertFound(contract, "Contract not found");

    const role: ContractRole = userId === booking.ownerId ? "OWNER" : "RENTER";
    return {
      id: contract.id,
      bookingId: contract.bookingId,
      status: contract.status,
      version: contract.version,
      contentHash: contract.contentHash,
      pdfHash: contract.pdfHash,
      lockedAt: contract.lockedAt,
      terms: contract.terms,
      renterAcceptedAt: contract.renterAcceptedAt,
      ownerAcceptedAt: contract.ownerAcceptedAt,
      myRole: role,
      acceptedByMe: contract.acceptances.some(
        (a) => a.userId === userId && a.contentHash === contract.contentHash,
      ),
      acceptances: contract.acceptances.map((a) => ({
        role: a.role,
        acceptedAt: a.acceptedAt,
        contentHash: a.contentHash,
        // La IP se muestra enmascarada a las partes: alcanza para reconocer
        // "fui yo, desde casa" sin darle a la otra parte la dirección entera.
        ip: maskIp(this.encryption.tryDecrypt(a.ipEncrypted)),
      })),
      createdAt: contract.createdAt,
      updatedAt: contract.updatedAt,
    };
  }

  /**
   * Una parte acepta el contrato VIGENTE. Idempotente: aceptar dos veces el
   * mismo contenido no crea dos filas.
   */
  async accept(userId: string, bookingId: string, ctx: AcceptanceContext = {}) {
    const booking = await this.participantBooking(userId, bookingId);
    if (!ACEPTABLE.includes(booking.status)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "CONTRACT_NOT_ACCEPTABLE",
        message: "Esta reserva ya no admite aceptar el contrato.",
        bookingStatus: booking.status,
      });
    }

    const contract = await this.ensureForBooking(bookingId);
    const contentHash = contract.contentHash as string;
    const role: ContractRole = userId === booking.ownerId ? "OWNER" : "RENTER";

    await this.prisma.$transaction(async (tx) => {
      const ya = await tx.contractAcceptance.findUnique({
        where: {
          contractId_userId_contentHash: {
            contractId: contract.id,
            userId,
            contentHash,
          },
        },
        select: { id: true },
      });
      if (!ya) {
        await tx.contractAcceptance.create({
          data: {
            contractId: contract.id,
            userId,
            role,
            contentHash,
            ipEncrypted: this.encryption.encrypt(ctx.ip ?? null),
            userAgentEncrypted: this.encryption.encrypt(ctx.userAgent ?? null),
          },
        });
      }

      const aceptaciones = await tx.contractAcceptance.findMany({
        where: { contractId: contract.id, contentHash },
        select: { role: true, acceptedAt: true },
      });
      const del = (r: ContractRole) =>
        aceptaciones.find((a) => a.role === r)?.acceptedAt ?? null;
      const ownerAcceptedAt = del("OWNER");
      const renterAcceptedAt = del("RENTER");

      await tx.contract.update({
        where: { id: contract.id },
        data: {
          lockedAt: contract.lockedAt ?? new Date(),
          ownerAcceptedAt,
          renterAcceptedAt,
          status:
            ownerAcceptedAt && renterAcceptedAt
              ? ContractStatus.ACCEPTED
              : ContractStatus.PENDING_ACCEPTANCE,
        },
      });
    });

    await this.auditLog.create({
      actorId: userId,
      targetUserId: role === "OWNER" ? booking.renterId : booking.ownerId,
      action: "contract.accepted",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { role, contentHash, version: contract.version },
    });

    return this.getForParticipant(userId, bookingId);
  }

  /**
   * ¿Esta parte aceptó el contenido VIGENTE? Es lo que el cobro exige antes
   * de cobrar: nadie paga bajo condiciones que no aceptó.
   */
  async hasAccepted(bookingId: string, role: ContractRole): Promise<boolean> {
    const contract = await this.prisma.contract.findUnique({
      where: { bookingId },
      select: { id: true, contentHash: true },
    });
    if (!contract?.contentHash) return false;
    const aceptacion = await this.prisma.contractAcceptance.findFirst({
      where: {
        contractId: contract.id,
        role,
        contentHash: contract.contentHash,
      },
      select: { id: true },
    });
    return Boolean(aceptacion);
  }

  /** El PDF guardado. Nunca se regenera un contrato ya bloqueado. */
  async renderPdf(userId: string, bookingId: string): Promise<Buffer> {
    await this.participantBooking(userId, bookingId);
    const contract = await this.ensureForBooking(bookingId);
    if (contract.pdfBytes) return Buffer.from(contract.pdfBytes);

    // Contrato viejo (anterior a este cambio) sin PDF guardado: se genera y se
    // guarda UNA vez desde sus términos, así la descarga siguiente es la misma.
    const pdf = await this.renderLegacyPdf(contract);
    await this.prisma.contract.update({
      where: { id: contract.id },
      data: { pdfBytes: new Uint8Array(pdf), pdfHash: sha256(pdf) },
    });
    return pdf;
  }

  // ── Internos ───────────────────────────────────────────────────────────

  private isLocked(contract: Contract): boolean {
    return Boolean(
      contract.lockedAt ||
      contract.renterAcceptedAt ||
      contract.ownerAcceptedAt,
    );
  }

  /**
   * Un contrato viejo, aceptado con el flujo anterior, no tiene hash. Se le
   * calcula sobre sus términos tal como están y se bloquea: desde acá no
   * puede cambiar, que es lo más que se puede hacer por él.
   */
  private async lockLegacyIfNeeded(contract: Contract): Promise<Contract> {
    if (contract.contentHash && contract.lockedAt) return contract;
    return this.prisma.contract.update({
      where: { id: contract.id },
      data: {
        contentHash: contract.contentHash ?? hashContent(contract.terms),
        lockedAt: contract.lockedAt ?? new Date(),
        version: contract.version ?? "legacy",
      },
    });
  }

  private async participantBooking(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { ownerId: true, renterId: true, status: true },
    });
    assertFound(booking, "Booking not found");
    try {
      assertParticipant(
        booking.ownerId,
        booking.renterId,
        userId,
        "You cannot access this contract",
      );
    } catch {
      throw new ForbiddenException({
        statusCode: 403,
        code: "NOT_A_PARTY",
        message: "No sos parte de este contrato.",
      });
    }
    return booking;
  }

  private buildContent(booking: BookingWithRelations): ContractContent {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const days = Math.max(
      1,
      Math.round(
        (booking.endDate.getTime() - booking.startDate.getTime()) / 86_400_000,
      ),
    );
    const policy = this.policy();
    return {
      version: CONTRACT_CLAUSES_VERSION,
      bookingId: booking.id,
      parties: {
        owner: { name: personName(booking.owner), dni: booking.owner.dni },
        renter: { name: personName(booking.renter), dni: booking.renter.dni },
      },
      vehicle: {
        description:
          [booking.vehicle.brand, booking.vehicle.model, booking.vehicle.year]
            .filter(Boolean)
            .join(" ") || "Vehículo",
        plate: booking.vehicle.plate ?? null,
      },
      period: {
        startDate: fmt(booking.startDate),
        endDate: fmt(booking.endDate),
        days,
      },
      ticket: buildTicket({
        currency: booking.currency,
        days,
        pricePerDay: booking.pricePerDaySnapshot,
        rentalSubtotal: booking.rentalSubtotalSnapshot,
        insurance: booking.insuranceSnapshot,
        commission: booking.platformFeeSnapshot,
        sena: booking.senaAmountSnapshot,
        deposit: booking.depositSnapshot,
      }),
      policy,
      clauses: buildClauses(policy),
    };
  }

  private async renderContentPdf(
    content: ContractContent,
    contentHash: string,
  ): Promise<Buffer> {
    const doc = new PDFDocument({
      margin: 50,
      info: { Title: "Contrato de alquiler" },
    });
    const done = toBuffer(doc);
    const money = (minor: number) =>
      `${(minor / 100).toFixed(2)} ${content.ticket.currency.toUpperCase()}`;

    doc
      .fontSize(18)
      .text("Contrato de alquiler de vehículo", { align: "center" });
    doc
      .moveDown(0.3)
      .fontSize(10)
      .text(`Reserva ${content.bookingId}`, { align: "center" });
    doc.moveDown();

    doc.fontSize(12).text("Partes", { underline: true });
    doc.fontSize(10);
    doc.text(
      `Dueño: ${content.parties.owner.name} — DNI ${content.parties.owner.dni ?? "s/d"}`,
    );
    doc.text(
      `Quien alquila: ${content.parties.renter.name} — DNI ${content.parties.renter.dni ?? "s/d"}`,
    );
    doc.moveDown();

    doc.fontSize(12).text("Vehículo y período", { underline: true });
    doc.fontSize(10);
    doc.text(
      `${content.vehicle.description}${content.vehicle.plate ? ` — patente ${content.vehicle.plate}` : ""}`,
    );
    doc.text(
      `Desde ${content.period.startDate} hasta ${content.period.endDate} (${content.period.days} días)`,
    );
    doc.moveDown();

    doc.fontSize(12).text("Precio (pago único)", { underline: true });
    doc.fontSize(10);
    for (const linea of content.ticket.lines) {
      doc.text(`${linea.label}: ${money(linea.amountMinor)}`);
    }
    doc.text(`Total: ${money(content.ticket.totalMinor)}`);
    doc.moveDown(0.3).text("Distribución:");
    for (const linea of content.ticket.distribution) {
      doc.text(`  ${linea.label}: ${money(linea.amountMinor)}`);
    }
    doc.text(
      `Depósito en garantía (retención, no cobro): ${money(content.ticket.deposit.amountMinor)}`,
    );
    doc.moveDown();

    doc.fontSize(12).text("Cláusulas", { underline: true });
    content.clauses.forEach((clausula, i) => {
      doc
        .moveDown(0.4)
        .fontSize(10)
        .text(`${i + 1}. ${clausula.title}`, { continued: false });
      doc.fontSize(9).text(clausula.text, { align: "justify" });
    });

    doc.moveDown();
    doc.fontSize(8).fillColor("#555");
    doc.text(`Versión de cláusulas: ${content.version}`);
    doc.text(`Resumen criptográfico del contenido (SHA-256): ${contentHash}`);
    doc.text(
      "Este documento se acepta electrónicamente desde la plataforma. Las " +
        "aceptaciones de cada parte, con fecha, hora y hash del texto aceptado, " +
        "constan en el registro de la reserva.",
    );
    doc.end();
    return done;
  }

  /** Solo para contratos de antes de este cambio, con la forma vieja de términos. */
  private async renderLegacyPdf(contract: Contract): Promise<Buffer> {
    const terms = contract.terms as Record<string, unknown>;
    const doc = new PDFDocument({ margin: 50 });
    const done = toBuffer(doc);
    doc
      .fontSize(18)
      .text("Contrato de alquiler de vehículo", { align: "center" });
    doc.moveDown().fontSize(10);
    doc.text(`Reserva ${contract.bookingId}`);
    doc.moveDown().text(JSON.stringify(terms, null, 2));
    doc
      .moveDown()
      .fontSize(8)
      .text(`Hash del contenido: ${contract.contentHash ?? "s/d"}`);
    doc.end();
    return done;
  }
}

type BookingWithRelations = Prisma.BookingGetPayload<{
  include: typeof BOOKING_INCLUDE;
}>;

function personName(user: {
  displayName: string | null;
  firstName: string;
  lastName: string;
}): string {
  // En un contrato va el nombre legal, no el apodo que la persona eligió
  // mostrar en la app.
  return (
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.displayName ||
    "Usuario"
  );
}

/**
 * JSON canónico: las claves ordenadas, siempre igual para el mismo contenido.
 * Sin esto, el mismo contrato serializado dos veces podía dar dos hashes
 * distintos solo porque cambió el orden de las propiedades.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function hashContent(content: unknown): string {
  return sha256(Buffer.from(canonicalJson(content), "utf8"));
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(".")) return ip.replace(/\.\d+$/, ".x");
  return ip.replace(/:[0-9a-f]*$/i, ":x");
}

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
