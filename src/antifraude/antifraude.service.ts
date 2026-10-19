import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../common/services/audit-log.service";
import {
  ActividadDeLaCuenta,
  DIAS_DE_LA_VENTANA,
  PUBLICACIONES_POR_DIA,
  PUBLICACIONES_POR_SEMANA,
  RESENAS_POR_DIA,
  RESENAS_POR_SEMANA,
  Senal,
  hayQueSuspender,
  puedePublicar,
  puedeResenar,
  senalesDe,
} from "./limites";
import { esCuentaExenta, exentosDeLaConfiguracion } from "./exentos";

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

/**
 * El guardián de la reputación.
 *
 * La política —los números y qué significa cada patrón— vive en limites.ts, sin
 * base de datos y con sus pruebas. Acá está lo otro: ir a buscar los datos,
 * llamar a la política, y hacer lo que diga.
 *
 * ── LOS DOS MOMENTOS, Y POR QUÉ SON DOS ───────────────────────────────────
 *
 *   ANTES de la acción  → los topes. Cortan y devuelven un mensaje que explica
 *                         cuándo se puede de nuevo. No acusan a nadie.
 *   DESPUÉS de la acción → las señales. Miran el patrón que quedó, no el acto.
 *
 * Tiene que ser después y no antes: el patrón incluye lo que la persona acaba
 * de hacer, y mirarlo antes dejaría siempre una reseña de ventaja.
 *
 * ── NADA DE ESTO PUEDE TIRAR ABAJO LA ACCIÓN QUE LO DISPARÓ ───────────────
 * Las señales corren con la reseña YA GUARDADA. Si fallan —la base se cayó un
 * segundo, una consulta se trabó—, lo que corresponde es que la reseña quede
 * igual y el problema grite en el log. Perder una reseña legítima porque el
 * antifraude tuvo un mal momento sería cambiar un problema chico por uno que la
 * persona ve.
 */
@Injectable()
export class AntifraudeService {
  private readonly logger = new Logger(AntifraudeService.name);
  /** Los mails de ANTIFRAUDE_EXENTOS, leídos una vez. Ver exentos.ts. */
  private readonly exentosExtra: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    config: ConfigService,
  ) {
    this.exentosExtra = exentosDeLaConfiguracion(
      config.get<string>("ANTIFRAUDE_EXENTOS"),
    );
    if (this.exentosExtra.length > 0) {
      this.logger.log(
        `${this.exentosExtra.length} cuenta(s) exentas por configuración.`,
      );
    }
  }

  // ── Los topes ───────────────────────────────────────────────────────────

  /**
   * Corta antes de guardar una reseña, si la persona ya escribió demasiadas.
   *
   * El mensaje dice QUÉ pasó y CUÁNDO se puede de nuevo. Un "no podés" a secas
   * sobre algo que la persona hizo de buena fe —terminó tres alquileres y los
   * quiso reseñar— la deja pensando que la aplicación está rota.
   */
  async assertPuedeResenar(userId: string): Promise<void> {
    if (await this.exenta(userId)) return;
    const actividad = await this.actividadDe(userId);
    const veredicto = puedeResenar(actividad);
    if (veredicto.permitido) return;

    const mensajes: Record<string, string> = {
      RESENAS_POR_DIA:
        `Ya dejaste ${RESENAS_POR_DIA} reseñas hoy. Podés seguir mañana: ` +
        "el límite existe para que nadie pueda fabricarse una reputación en una tarde.",
      RESENAS_POR_SEMANA:
        `Ya dejaste ${RESENAS_POR_SEMANA} reseñas esta semana. El límite se ` +
        "renueva en los próximos días; tus reservas no se vencen, podés reseñarlas después.",
    };
    throw new BadRequestException({
      statusCode: 400,
      code: veredicto.motivo,
      message: (veredicto.motivo && mensajes[veredicto.motivo]) ?? "",
      horasDeEspera: veredicto.horasDeEspera,
    });
  }

  /** Lo mismo al publicar un auto. Publicar nunca suspende, solo se frena. */
  async assertPuedePublicar(userId: string): Promise<void> {
    if (await this.exenta(userId)) return;
    const actividad = await this.actividadDe(userId);
    const veredicto = puedePublicar(actividad);
    if (veredicto.permitido) return;

    const mensajes: Record<string, string> = {
      PUBLICACIONES_POR_DIA:
        `Publicaste ${PUBLICACIONES_POR_DIA} autos hoy, que es el máximo por día. ` +
        "Podés seguir mañana. Si tenés una flota para cargar, escribinos y lo habilitamos.",
      PUBLICACIONES_POR_SEMANA:
        `Publicaste ${PUBLICACIONES_POR_SEMANA} autos esta semana, que es el máximo. ` +
        "Si tenés una flota para cargar, escribinos y lo habilitamos.",
    };
    throw new BadRequestException({
      statusCode: 400,
      code: veredicto.motivo,
      message: (veredicto.motivo && mensajes[veredicto.motivo]) ?? "",
      horasDeEspera: veredicto.horasDeEspera,
    });
  }

  // ── Las señales ─────────────────────────────────────────────────────────

  /**
   * Mira el patrón que quedó y actúa. Se llama DESPUÉS de la acción.
   *
   * Nunca lanza: ver la nota de la clase. Lo peor que puede pasar acá es que
   * una señal no se registre, y eso no se le puede cobrar a quien acaba de
   * escribir una reseña legítima.
   */
  async revisarDespuesDe(userId: string): Promise<Senal[]> {
    try {
      if (await this.exenta(userId)) return [];
      const actividad = await this.actividadDe(userId);
      const senales = senalesDe(actividad);
      if (senales.length === 0) return [];

      const suspender = hayQueSuspender(senales);
      await this.anotar(userId, senales, suspender);
      if (suspender) await this.suspender(userId, senales);
      return senales;
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `no se pudo revisar la cuenta ${userId}: ${mensaje}. ` +
          "La acción que lo disparó queda igual.",
      );
      return [];
    }
  }

  /**
   * Guarda las señales nuevas.
   *
   * NO SE REPITE UNA SEÑAL QUE YA ESTÁ ABIERTA. Sin esto, cada reseña nueva de
   * una cuenta marcada agregaría otra fila idéntica, y en dos días la bandeja
   * del panel serían cien avisos del mismo caso: el ruido tapa lo que importa,
   * que es que haya un caso nuevo.
   */
  private async anotar(
    userId: string,
    senales: Senal[],
    suspender: boolean,
  ): Promise<void> {
    const abiertas = await this.prisma.fraudSignal.findMany({
      where: { userId, resolvedAt: null },
      select: { kind: true },
    });
    const yaEstan = new Set(abiertas.map((s) => s.kind));

    const nuevas = senales.filter((s) => !yaEstan.has(s.tipo));
    if (nuevas.length === 0) return;

    await this.prisma.fraudSignal.createMany({
      data: nuevas.map((s) => ({
        userId,
        kind: s.tipo,
        detail: s.detalle as Prisma.InputJsonValue,
        autoSuspended: s.suspende && suspender,
      })),
    });
    this.logger.warn(
      `cuenta ${userId}: ${nuevas.map((s) => s.tipo).join(", ")}`,
    );
  }

  /**
   * Cierra la cuenta, sin esperar a nadie.
   *
   * Solo llega acá el anillo de reseñas, que es el único patrón sin explicación
   * inocente razonable (ver limites.ts). Queda en el registro de auditoría con
   * los números que lo dispararon: una suspensión que nadie puede revisar
   * después es tan mala como no suspender.
   *
   * SE PUEDE DESHACER desde el panel, con PATCH /admin/users/:id/status. Eso no
   * es un detalle: un control automático que no se puede revertir deja de ser
   * un control y pasa a ser una trampa.
   */
  private async suspender(userId: string, senales: Senal[]): Promise<void> {
    const cuenta = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    // Ya suspendida: no se vuelve a suspender ni se anota dos veces.
    if (!cuenta || cuenta.status === UserStatus.SUSPENDED) return;

    await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.SUSPENDED },
    });
    await this.auditLog.create({
      // SIN ACTOR, a propósito: no la cerró una persona, la cerró la regla.
      // Poner acá al administrador diría que él la suspendió, y la diferencia
      // importa el día que alguien reclame.
      targetUserId: userId,
      action: "antifraude.cuenta_suspendida",
      entityType: "User",
      entityId: userId,
      metadata: {
        senales: senales.filter((s) => s.suspende).map((s) => s.tipo),
        // Los números que la dispararon, en un objeto y no en una lista: el
        // campo de la base es JSON de objeto.
        detalle: Object.fromEntries(
          senales
            .filter((s) => s.suspende)
            .map((s) => [s.tipo, s.detalle as Prisma.InputJsonValue]),
        ),
      },
    });
    this.logger.warn(
      `cuenta ${userId} SUSPENDIDA automáticamente por anillo de reseñas.`,
    );
  }

  // ── Los datos ───────────────────────────────────────────────────────────

  /** Si a esta cuenta no se le aplica nada de esto. Ver exentos.ts. */
  private async exenta(userId: string): Promise<boolean> {
    const cuenta = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, role: true },
    });
    return esCuentaExenta(cuenta, this.exentosExtra);
  }

  /**
   * Todo lo que la política necesita saber de una cuenta, en una sola pasada.
   *
   * Se traen las reseñas de la ventana y se cuentan ACÁ en vez de pedirle siete
   * conteos distintos a la base. Son como mucho unos cientos de filas por
   * cuenta, y a cambio queda un solo viaje y una sola foto coherente del
   * momento: con siete consultas, una reseña que entra en el medio puede
   * aparecer en una y no en otra.
   */
  async actividadDe(
    userId: string,
    ahora: Date = new Date(),
  ): Promise<ActividadDeLaCuenta> {
    const desdeLaVentana = new Date(ahora.getTime() - DIAS_DE_LA_VENTANA * DIA);
    const desdeLaSemana = new Date(ahora.getTime() - 7 * DIA);
    const desdeElDia = new Date(ahora.getTime() - DIA);

    const [cuenta, escritasEnLaVentana, recibidas, publicaciones] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { createdAt: true },
        }),
        this.prisma.review.findMany({
          where: { authorId: userId, createdAt: { gte: desdeLaVentana } },
          select: { targetUserId: true, createdAt: true },
        }),
        /*
          TODAS las recibidas, no solo las de la ventana: la concentración
          —"casi todo lo que tiene viene de dos cuentas"— es una propiedad del
          perfil entero. Mirando treinta días, un perfil inflado hace seis meses
          se vería limpio, que es justo al revés de lo que se quiere.
        */
        this.prisma.review.findMany({
          where: { targetUserId: userId },
          select: { authorId: true, createdAt: true },
        }),
        this.prisma.listing.findMany({
          where: { ownerId: userId, createdAt: { gte: desdeLaSemana } },
          select: { createdAt: true },
        }),
      ]);

    const despuesDe = (fecha: Date) => (x: { createdAt: Date }) =>
      x.createdAt >= fecha;

    // Lo que le escribió a cada cuenta, y lo que recibió de cada una, dentro de
    // la ventana. El cruce de los dos mapas es lo que revela un circuito.
    const escritasPorCuenta = new Map<string, number>();
    for (const r of escritasEnLaVentana) {
      escritasPorCuenta.set(
        r.targetUserId,
        (escritasPorCuenta.get(r.targetUserId) ?? 0) + 1,
      );
    }
    const recibidasPorCuenta = new Map<string, number>();
    for (const r of recibidas) {
      recibidasPorCuenta.set(
        r.authorId,
        (recibidasPorCuenta.get(r.authorId) ?? 0) + 1,
      );
    }
    const recibidasEnLaVentanaPorCuenta = new Map<string, number>();
    for (const r of recibidas.filter(despuesDe(desdeLaVentana))) {
      recibidasEnLaVentanaPorCuenta.set(
        r.authorId,
        (recibidasEnLaVentanaPorCuenta.get(r.authorId) ?? 0) + 1,
      );
    }

    const cruces = [...escritasPorCuenta.entries()].map(
      ([otroId, escritas]) => ({
        otroId,
        escritas,
        recibidas: recibidasEnLaVentanaPorCuenta.get(otroId) ?? 0,
      }),
    );

    // Las dos cuentas que más la reseñaron, sobre el total de recibidas.
    const porCantidad = [...recibidasPorCuenta.values()].sort((a, b) => b - a);
    const recibidasDeLosDosQueMas = porCantidad
      .slice(0, 2)
      .reduce((suma, n) => suma + n, 0);

    const creada = cuenta?.createdAt ?? ahora;
    return {
      resenasEscritasHoy: escritasEnLaVentana.filter(despuesDe(desdeElDia))
        .length,
      resenasEscritasEnLaSemana: escritasEnLaVentana.filter(
        despuesDe(desdeLaSemana),
      ).length,
      publicacionesHoy: publicaciones.filter(despuesDe(desdeElDia)).length,
      publicacionesEnLaSemana: publicaciones.length,
      cruces,
      recibidas: recibidas.length,
      recibidasDeLosDosQueMas,
      diasDeAntiguedad: Math.max(
        0,
        Math.floor((ahora.getTime() - creada.getTime()) / DIA),
      ),
    };
  }
}
