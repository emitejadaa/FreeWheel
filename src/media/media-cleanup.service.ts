import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CloudinaryService } from "./cloudinary.service";

/** Las URLs de una cuenta, leídas antes de borrarla de la base. */
export interface OwnedMedia {
  urls: string[];
}

/**
 * Borrar del storage lo que sube una cuenta.
 *
 * ── Por qué es un servicio aparte ───────────────────────────────────────────
 * Los archivos de una cuenta están repartidos en tres lugares distintos —las
 * filas de MediaAsset (fotos de perfil, de autos y de avisos), el
 * `profilePhotoUrl` del propio User, y los documentos de identidad, que viven
 * en DocumentVerification y no en MediaAsset—, así que "todo lo que subió esta
 * persona" no es una consulta sola. Juntarlo acá evita que quien borra una
 * cuenta tenga que acordarse de los tres.
 *
 * ── Best-effort, a propósito ────────────────────────────────────────────────
 * Cloudinary es un servicio externo: puede estar caído, sin credenciales
 * cargadas, o el archivo puede no existir. Nada de eso puede hacer fracasar el
 * borrado de la cuenta, que ya pasó y no se deshace. Los fallos se registran en
 * el log y se cuentan, y lo peor que queda es un archivo huérfano ocupando
 * lugar.
 */
@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger(MediaCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * Todas las URLs de archivos de esta cuenta. Se llama ANTES de borrarla:
   * después las filas ya no están y no hay forma de saber qué había que borrar.
   *
   * Incluye los documentos de identidad y los assets marcados como DELETED: si
   * el archivo sigue en Cloudinary, sigue habiendo que borrarlo.
   */
  async collectOwnedMedia(userId: string): Promise<OwnedMedia> {
    const [assets, user, verifications] = await Promise.all([
      this.prisma.mediaAsset.findMany({
        where: { ownerId: userId },
        select: { url: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { profilePhotoUrl: true },
      }),
      this.prisma.documentVerification.findMany({
        where: { userId },
        select: { frontUrl: true, backUrl: true },
      }),
    ]);

    const urls = [
      ...assets.map((asset) => asset.url),
      user?.profilePhotoUrl ?? null,
      ...verifications.flatMap((row) => [row.frontUrl, row.backUrl]),
    ].filter((url): url is string => typeof url === "string" && url.length > 0);

    return { urls };
  }

  /**
   * Borra esos archivos de Cloudinary. Devuelve cuántos se borraron y cuántos
   * no se pudieron.
   *
   * Se deduplica por `public_id` y no por URL: la foto de perfil aparece dos
   * veces —en `User.profilePhotoUrl` y en su fila de MediaAsset— y a veces con
   * la URL escrita distinto, así que sin esto se intentaría borrarla dos veces
   * y la segunda contaría como un fallo que no ocurrió.
   */
  async deleteMedia(media: OwnedMedia): Promise<{
    deleted: number;
    failed: number;
  }> {
    const porPublicId = new Map<string, string>();
    for (const url of media.urls) {
      const asset = this.cloudinary.parseAssetUrl(url);
      if (!asset) {
        this.logger.warn(`No se pudo interpretar la URL, no se toca: ${url}`);
        continue;
      }
      porPublicId.set(`${asset.deliveryType}:${asset.publicId}`, url);
    }

    let deleted = 0;
    let failed = 0;
    for (const url of porPublicId.values()) {
      try {
        await this.cloudinary.destroyByUrl(url);
        deleted += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `No se pudo borrar ${url} del storage: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return { deleted, failed };
  }
}
