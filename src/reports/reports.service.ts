import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  ListingStatus,
  ReportStatus,
  ReportTargetType,
  UserStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AiService } from "../ai/ai.service";
import { assertFound } from "../common/utils/entity.util";
import { USER_PUBLIC_SELECT } from "../common/constants/prisma-select";
import { CreateReportDto } from "./dto/create-report.dto";
import { ReportAction, ResolveReportDto } from "./dto/resolve-report.dto";

/**
 * Reportes de las personas sobre publicaciones o sobre otras cuentas.
 *
 * Antes el botón "Reportar" guardaba el texto en el navegador de quien reportaba:
 * nadie lo veía nunca. Ahora queda en la base, lo lee la IA para decir si lo
 * denunciado tiene relación con la publicación, y aparece en el panel de las
 * cuentas administradoras, que pueden pausar o eliminar el aviso.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  async create(reporterId: string, data: CreateReportDto) {
    if (data.targetType === ReportTargetType.LISTING && !data.listingId) {
      throw new BadRequestException("Falta la publicación reportada");
    }
    if (data.targetType === ReportTargetType.USER && !data.targetUserId) {
      throw new BadRequestException("Falta la persona reportada");
    }

    const listing = data.listingId
      ? await this.prisma.listing.findUnique({
          where: { id: data.listingId },
          include: { vehicle: true },
        })
      : null;

    if (data.listingId) assertFound(listing, "Listing not found");

    // Si se reporta una publicación, el dueño queda registrado como la persona
    // apuntada: es a quien un admin puede llegar a sancionar.
    const targetUserId = data.targetUserId ?? listing?.ownerId ?? null;

    const report = await this.prisma.report.create({
      data: {
        reporterId,
        targetType: data.targetType,
        listingId: data.listingId,
        targetUserId,
        reason: data.reason,
        details: data.details,
      },
    });

    // Lectura automática. Nunca hace fallar el reporte: si la IA no está
    // disponible, el reporte queda igual y un admin lo lee a mano.
    void this.runAiCheck(report.id, data, listing);

    return report;
  }

  /**
   * Le pide a la IA que compare lo denunciado con lo que dice la publicación y
   * guarda el resultado en el reporte. Le ahorra al admin tener que leer de cero
   * los reportes que no tienen nada que ver con el aviso.
   */
  private async runAiCheck(
    reportId: string,
    data: CreateReportDto,
    listing: { title: string; description: string } | null,
  ) {
    try {
      const context = listing
        ? `Título: ${listing.title}\nDescripción: ${listing.description}`
        : "No hay publicación asociada: el reporte es sobre una persona.";

      const answer = await this.ai.chat(
        [
          {
            role: "system",
            content:
              "Sos un moderador de una app de alquiler de autos entre personas. " +
              "Tenés que decidir si un reporte tiene relación con la publicación " +
              "denunciada. Respondé SOLO un JSON válido, sin texto alrededor, con " +
              'la forma {"veredicto": "COHERENT"|"INCOHERENT"|"UNCLEAR", ' +
              '"resumen": "una o dos frases explicando por qué"}. ' +
              "COHERENT: lo que se denuncia se corresponde con la publicación. " +
              "INCOHERENT: no tiene relación, parece un error o un reporte falso. " +
              "UNCLEAR: no alcanza la información para decidir.",
          },
          {
            role: "user",
            content:
              `PUBLICACIÓN REPORTADA\n${context}\n\n` +
              `MOTIVO: ${data.reason}\n` +
              `DESCRIPCIÓN: ${data.details}`,
          },
        ],
        0,
      );

      const parsed = this.extractVerdict(answer.content);
      if (!parsed) return;

      await this.prisma.report.update({
        where: { id: reportId },
        data: {
          aiVerdict: parsed.verdict,
          aiSummary: parsed.summary,
          aiCheckedAt: new Date(),
        },
      });
      this.logger.log(`Reporte ${reportId} revisado por IA: ${parsed.verdict}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`No se pudo revisar el reporte ${reportId}: ${message}`);
    }
  }

  /** Lee el JSON que devolvió el modelo, tolerando texto alrededor. */
  private extractVerdict(content: string): {
    verdict: "COHERENT" | "INCOHERENT" | "UNCLEAR";
    summary: string;
  } | null {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[0]) as {
        veredicto?: string;
        resumen?: string;
      };
      const verdict = (parsed.veredicto ?? "").toUpperCase();
      if (!["COHERENT", "INCOHERENT", "UNCLEAR"].includes(verdict)) return null;

      return {
        verdict: verdict as "COHERENT" | "INCOHERENT" | "UNCLEAR",
        summary: (parsed.resumen ?? "").slice(0, 500),
      };
    } catch {
      return null;
    }
  }

  /** Los reportes que hizo una persona (para poder ver en qué quedaron). */
  listMine(reporterId: string) {
    return this.prisma.report.findMany({
      where: { reporterId },
      orderBy: { createdAt: "desc" },
      include: { listing: { select: { id: true, title: true } } },
    });
  }

  /** Bandeja del admin. Por defecto, los que están sin resolver primero. */
  listForAdmin(status?: ReportStatus) {
    return this.prisma.report.findMany({
      where: status ? { status } : {},
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: {
        reporter: { select: USER_PUBLIC_SELECT },
        targetUser: { select: USER_PUBLIC_SELECT },
        listing: {
          select: { id: true, title: true, status: true, ownerId: true },
        },
      },
      take: 200,
    });
  }

  /** Cuántos reportes están esperando: es el número que el panel muestra. */
  async countOpen() {
    return this.prisma.report.count({ where: { status: ReportStatus.OPEN } });
  }

  /**
   * El admin resuelve el reporte y, si hace falta, actúa sobre la publicación o
   * la cuenta. Todo queda registrado: quién lo resolvió, cuándo y con qué nota.
   */
  async resolve(adminId: string, reportId: string, data: ResolveReportDto) {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });
    assertFound(report, "Report not found");

    if (report.status !== ReportStatus.OPEN) {
      throw new BadRequestException("El reporte ya estaba resuelto");
    }

    const needsListing =
      data.action === ReportAction.PAUSE_LISTING ||
      data.action === ReportAction.DELETE_LISTING;

    if (needsListing && !report.listingId) {
      throw new BadRequestException(
        "El reporte no apunta a una publicación: no se puede pausar ni eliminar",
      );
    }
    if (data.action === ReportAction.SUSPEND_USER && !report.targetUserId) {
      throw new BadRequestException("El reporte no apunta a una cuenta");
    }

    if (data.action === ReportAction.PAUSE_LISTING && report.listingId) {
      await this.prisma.listing.update({
        where: { id: report.listingId },
        data: { status: ListingStatus.PAUSED },
      });
    }

    if (data.action === ReportAction.DELETE_LISTING && report.listingId) {
      await this.prisma.listing.update({
        where: { id: report.listingId },
        data: { status: ListingStatus.DELETED },
      });
    }

    if (data.action === ReportAction.SUSPEND_USER && report.targetUserId) {
      await this.prisma.user.update({
        where: { id: report.targetUserId },
        data: { status: UserStatus.SUSPENDED },
      });
    }

    const updated = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        status:
          data.action === ReportAction.DISMISS
            ? ReportStatus.DISMISSED
            : ReportStatus.ACTION_TAKEN,
        resolvedById: adminId,
        resolvedAt: new Date(),
        resolutionNote: data.note ?? data.action,
      },
    });

    this.logger.log(
      `Reporte ${reportId} resuelto por ${adminId}: ${data.action}`,
    );
    return updated;
  }
}
