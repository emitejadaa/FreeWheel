import { Injectable } from "@nestjs/common";
import { ContractStatus, Prisma } from "@prisma/client";
import PDFDocument from "pdfkit";
import { AuditLogService } from "../common/services/audit-log.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { PrismaService } from "../prisma/prisma.service";

const BOOKING_INCLUDE = {
  owner: true,
  renter: true,
  vehicle: true,
  listing: true,
} satisfies Prisma.BookingInclude;

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Creates (or refreshes) the digital contract for a booking from its locked
   * pricing snapshots. Idempotent per booking.
   */
  async createForBooking(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: BOOKING_INCLUDE,
    });
    assertFound(booking, "Booking not found");

    const terms = this.buildTerms(booking);
    const contract = await this.prisma.contract.upsert({
      where: { bookingId },
      create: {
        bookingId,
        status: ContractStatus.PENDING_ACCEPTANCE,
        terms: terms as unknown as Prisma.InputJsonValue,
        pdfUrl: `/contracts/bookings/${bookingId}/pdf`,
      },
      update: { terms: terms as unknown as Prisma.InputJsonValue },
    });

    await this.auditLog.create({
      actorId: booking.ownerId,
      targetUserId: booking.renterId,
      action: "contract.created",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { contractId: contract.id },
    });

    return contract;
  }

  async getForParticipant(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { ownerId: true, renterId: true },
    });
    assertFound(booking, "Booking not found");
    assertParticipant(
      booking.ownerId,
      booking.renterId,
      userId,
      "You cannot access this contract",
    );

    const contract = await this.prisma.contract.findUnique({
      where: { bookingId },
    });
    assertFound(contract, "Contract not found");
    return contract;
  }

  async accept(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { ownerId: true, renterId: true },
    });
    assertFound(booking, "Booking not found");
    assertParticipant(
      booking.ownerId,
      booking.renterId,
      userId,
      "You cannot accept this contract",
    );

    const contract = await this.prisma.contract.findUnique({
      where: { bookingId },
    });
    assertFound(contract, "Contract not found");

    const isOwner = userId === booking.ownerId;
    const renterAcceptedAt =
      contract.renterAcceptedAt ?? (isOwner ? null : new Date());
    const ownerAcceptedAt =
      contract.ownerAcceptedAt ?? (isOwner ? new Date() : null);
    const bothAccepted = Boolean(renterAcceptedAt && ownerAcceptedAt);

    const updated = await this.prisma.contract.update({
      where: { bookingId },
      data: {
        renterAcceptedAt,
        ownerAcceptedAt,
        status: bothAccepted
          ? ContractStatus.ACCEPTED
          : ContractStatus.PENDING_ACCEPTANCE,
      },
    });

    await this.auditLog.create({
      actorId: userId,
      action: "contract.accepted",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { by: isOwner ? "owner" : "renter", bothAccepted },
    });

    return updated;
  }

  async renderPdf(userId: string, bookingId: string): Promise<Buffer> {
    const contract = await this.getForParticipant(userId, bookingId);
    const terms = contract.terms as unknown as ContractTerms;

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const buffer = this.toBuffer(doc);

    doc
      .fontSize(20)
      .text("FreeWheel — Contrato de alquiler", { align: "center" });
    doc.moveDown();
    doc.fontSize(10).fillColor("#555").text(`Contrato ${contract.id}`, {
      align: "center",
    });
    doc.text(`Reserva ${terms.bookingId}`, { align: "center" });
    doc.moveDown().fillColor("#000");

    this.section(doc, "Partes");
    doc.fontSize(11);
    doc.text(`Propietario (owner): ${terms.owner.name} <${terms.owner.email}>`);
    doc.text(
      `Arrendatario (renter): ${terms.renter.name} <${terms.renter.email}>`,
    );
    doc.moveDown();

    this.section(doc, "Vehículo y fechas");
    doc.fontSize(11);
    doc.text(`Vehículo: ${terms.vehicle}`);
    doc.text(`Desde: ${terms.startDate}`);
    doc.text(`Hasta: ${terms.endDate}`);
    doc.text(`Días: ${terms.days}`);
    doc.moveDown();

    this.section(doc, "Detalle económico");
    doc.fontSize(11);
    const c = terms.currency.toUpperCase();
    const money = (n: number) => `${c} ${n.toFixed(2)}`;
    doc.text(`Precio por día: ${money(terms.pricePerDay)}`);
    doc.text(`Subtotal alquiler: ${money(terms.rentalSubtotal)}`);
    doc.text(`Seguro (incluido en el total): ${money(terms.insurance)}`);
    doc.text(`Total a pagar por el renter: ${money(terms.total)}`);
    doc.text(`  • Seña (al aceptar): ${money(terms.sena)}`);
    doc.text(`  • Saldo (antes del pickup): ${money(terms.balance)}`);
    doc.text(`Depósito de garantía (retención): ${money(terms.deposit)}`);
    doc.moveDown(0.5);
    doc.text(`Comisión de la plataforma: ${money(terms.commission)}`);
    doc.text(`Pago al owner (al check-out): ${money(terms.ownerPayout)}`);
    doc.moveDown();

    this.section(doc, "Condiciones");
    doc.fontSize(10).fillColor("#333");
    doc.text(
      "La seña se cobra al aceptar la reserva y el saldo antes del retiro. " +
        "El depósito de garantía es una retención (hold) que se libera al " +
        "completar la devolución sin daños, o se captura total/parcialmente en " +
        "caso de daño. El pago al owner se transfiere al confirmarse el " +
        "check-out. Todos los importes están expresados en " +
        `${c} (modo de prueba).`,
      { align: "justify" },
    );
    doc.moveDown();
    doc.fillColor("#000").fontSize(10);
    doc.text(`Aceptación owner: ${terms.ownerAcceptedAt ?? "pendiente"}`);
    doc.text(`Aceptación renter: ${terms.renterAcceptedAt ?? "pendiente"}`);

    doc.end();
    return buffer;
  }

  private section(doc: PDFKit.PDFDocument, title: string): void {
    doc.fontSize(13).fillColor("#1a73e8").text(title);
    doc.fillColor("#000");
  }

  private toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });
  }

  private buildTerms(booking: BookingWithRelations): ContractTerms {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return {
      bookingId: booking.id,
      currency: booking.currency,
      owner: {
        name: this.name(booking.owner),
        email: booking.owner.email,
      },
      renter: {
        name: this.name(booking.renter),
        email: booking.renter.email,
      },
      vehicle:
        [booking.vehicle.brand, booking.vehicle.model, booking.vehicle.year]
          .filter(Boolean)
          .join(" ") || "Vehículo",
      startDate: fmt(booking.startDate),
      endDate: fmt(booking.endDate),
      days: Math.max(
        1,
        Math.round(
          (booking.endDate.getTime() - booking.startDate.getTime()) /
            86_400_000,
        ),
      ),
      pricePerDay: booking.pricePerDaySnapshot,
      rentalSubtotal: booking.rentalSubtotalSnapshot ?? 0,
      insurance: booking.insuranceSnapshot ?? 0,
      commission: booking.platformFeeSnapshot ?? 0,
      total: booking.totalPriceSnapshot,
      sena: booking.senaAmountSnapshot ?? 0,
      balance: booking.balanceAmountSnapshot ?? 0,
      deposit: booking.depositSnapshot ?? 0,
      ownerPayout: booking.ownerPayoutSnapshot ?? 0,
      ownerAcceptedAt: null,
      renterAcceptedAt: null,
    };
  }

  private name(user: {
    displayName: string | null;
    firstName: string;
    lastName: string;
  }): string {
    return (
      user.displayName ||
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      "Usuario"
    );
  }
}

type BookingWithRelations = Prisma.BookingGetPayload<{
  include: typeof BOOKING_INCLUDE;
}>;

interface ContractTerms {
  bookingId: string;
  currency: string;
  owner: { name: string; email: string };
  renter: { name: string; email: string };
  vehicle: string;
  startDate: string;
  endDate: string;
  days: number;
  pricePerDay: number;
  rentalSubtotal: number;
  insurance: number;
  commission: number;
  total: number;
  sena: number;
  balance: number;
  deposit: number;
  ownerPayout: number;
  ownerAcceptedAt: string | null;
  renterAcceptedAt: string | null;
}
