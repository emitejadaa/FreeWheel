import {
  BadRequestException,
  Injectable,
  NotImplementedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RegisterMediaAssetDto } from "./dto/register-media-asset.dto";

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  createPresignedUpload(): never {
    throw new NotImplementedException(
      "Real media storage is not integrated yet",
    );
  }

  /**
   * Genera una firma para subir a Cloudinary de forma segura: el API secret
   * nunca sale del backend. El front sube el archivo directo a Cloudinary
   * usando esta firma + timestamp.
   *
   * Firma media genérica y pública (fotos de perfil, vehículos, publicaciones).
   * Los documentos de identidad NO pasan por acá: tienen su propio endpoint
   * (POST /verification/identity/upload-signature) que fuerza la carpeta del
   * usuario y sube como authenticated.
   */
  signUpload(folder = "freewheel") {
    if (/^identity(\/|$)/.test(folder)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "RESERVED_MEDIA_FOLDER",
        message:
          "La carpeta identity/ está reservada: usá POST /verification/identity/upload-signature",
      });
    }

    const cloudName = this.config.get<string>("CLOUDINARY_CLOUD_NAME");
    const apiKey = this.config.get<string>("CLOUDINARY_API_KEY");
    const apiSecret = this.config.get<string>("CLOUDINARY_API_SECRET");

    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException(
        "Cloudinary no esta configurado en el servidor",
      );
    }

    const timestamp = Math.round(Date.now() / 1000);
    const toSign = `folder=${folder}&timestamp=${timestamp}`;
    const signature = createHash("sha1")
      .update(toSign + apiSecret)
      .digest("hex");

    return { cloudName, apiKey, timestamp, signature, folder };
  }

  /**
   * Guarda un archivo ya subido (a Cloudinary) como asset del usuario.
   *
   * El archivo entra AL FINAL de la fila, no al principio. Ahora que el dueño
   * puede ordenar las fotos de su auto, el lugar por defecto importa: con
   * position 0 —el valor de la columna—, una foto agregada después de haber
   * ordenado quedaría empatada con la que el dueño puso de portada, y la base
   * elegiría cuál va primero. Agregar una foto le cambiaría la portada al aviso
   * sin que nadie lo haya pedido.
   *
   * Se cuenta lo que ya hay en la misma entidad para saber cuál es el final.
   * Cuando el asset no está pegado a nada (entityId vacío), no hay fila en la
   * que ponerse y queda en 0, que es lo que valía antes.
   */
  async registerAsset(ownerId: string, data: RegisterMediaAssetDto) {
    const position =
      data.entityType && data.entityId
        ? await this.prisma.mediaAsset.count({
            where: {
              entityType: data.entityType,
              entityId: data.entityId,
              kind: data.kind,
            },
          })
        : 0;

    return this.prisma.mediaAsset.create({
      data: {
        ...data,
        ownerId,
        position,
      },
    });
  }

  listMine(ownerId: string) {
    return this.prisma.mediaAsset.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
    });
  }
}
