import {
  BadRequestException,
  Injectable,
  NotImplementedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "crypto";
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
  /**
   * ── POR QUÉ LA FIRMA LLEVA UN `public_id` QUE ELIGE EL SERVIDOR ──────────
   *
   * Antes se firmaba `folder=freewheel&timestamp=...` y nada más. Esa firma
   * sirve para subir CUALQUIER cantidad de archivos a esa carpeta mientras
   * Cloudinary la siga aceptando, y cada archivo es uno nuevo. O sea: pedir
   * una firma y repetir la subida desde la consola del navegador llenaba la
   * cuenta de Cloudinary sin volver a pasar por el servidor ni una vez. Poner
   * un tope a los pedidos de firma no arreglaba nada, porque UNA firma ya
   * alcanzaba.
   *
   * Con el `public_id` adentro de lo firmado, Cloudinary solo acepta subir a
   * ESE nombre. Repetir la subida sobrescribe el mismo archivo en vez de
   * agregar otro, así que una firma es, como mucho, una foto guardada. Y eso
   * es lo que convierte el tope de firmas por día en un tope de FOTOS por día,
   * que es lo que se quería tener.
   *
   * El nombre lo arma el servidor con el id de la cuenta adentro —nunca el
   * cliente— por el mismo motivo que en los documentos de identidad: si el
   * navegador pudiera elegirlo, podría pisar el archivo de otra persona.
   *
   * El `folder` sigue viniendo en la respuesta para que el front viejo —el que
   * todavía manda `folder` y no `params`— siga funcionando mientras se
   * publican las dos puntas.
   */
  signUpload(userId: string, folder = "freewheel") {
    // La comparación va SIN distinguir mayúsculas. Hoy Cloudinary trata
    // "Identity/" y "identity/" como carpetas distintas, así que escribir la
    // palabra con mayúscula no da acceso a los documentos de nadie — pero eso
    // es un detalle de Cloudinary, no una decisión nuestra, y una reserva que
    // depende de cómo otro producto normaliza sus nombres es una reserva que
    // se puede caer sin que nos enteremos. Reservada es reservada en cualquier
    // grafía.
    //
    // vehicle-docs/ es la cédula de los autos: lleva el nombre y el DNI del
    // titular, igual que un documento de identidad, y tiene su propia firma
    // que la sube como authenticated. Las barras del principio se ignoran para
    // la comparación por la misma razón que las mayúsculas: "/identity" no
    // puede ser una forma de esquivar la reserva según cómo normalice
    // Cloudinary la ruta.
    const reserved = /^(identity|vehicle-docs)(\/|$)/i.exec(
      folder.trim().replace(/^\/+/, ""),
    );
    if (reserved) {
      const isVehicleDocs = reserved[1].toLowerCase() === "vehicle-docs";
      throw new BadRequestException({
        statusCode: 400,
        code: "RESERVED_MEDIA_FOLDER",
        message: isVehicleDocs
          ? "La carpeta vehicle-docs/ está reservada: usá POST /vehicles/:vehicleId/verification/upload-signature"
          : "La carpeta identity/ está reservada: usá POST /verification/identity/upload-signature",
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
    // El nombre del archivo: la carpeta pedida, la cuenta que sube, y un azar
    // que hace que dos fotos del mismo segundo no se pisen entre ellas.
    const limpia = folder.trim().replace(/^\/+|\/+$/g, "") || "freewheel";
    const publicId = `${limpia}/${userId}/${Date.now()}_${randomBytes(4).toString("hex")}`;

    // Se firma el public_id y NO el folder: el public_id ya trae la carpeta
    // adentro, y mandar los dos hace que Cloudinary anteponga la carpeta otra
    // vez y el archivo termine en freewheel/freewheel/<id>/...
    const toSign = `public_id=${publicId}&timestamp=${timestamp}`;
    const signature = createHash("sha1")
      .update(toSign + apiSecret)
      .digest("hex");

    return {
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder: limpia,
      publicId,
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      /** Copiar tal cual al FormData, más `file`. Nada más, nada menos. */
      params: {
        public_id: publicId,
        timestamp: String(timestamp),
        api_key: apiKey,
        signature,
      },
    };
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
