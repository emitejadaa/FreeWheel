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

  registerAsset(ownerId: string, data: RegisterMediaAssetDto) {
    return this.prisma.mediaAsset.create({
      data: {
        ...data,
        ownerId,
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
