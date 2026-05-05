import { Injectable, NotImplementedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterMediaAssetDto } from './dto/register-media-asset.dto';

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService) {}

  createPresignedUpload(): never {
    throw new NotImplementedException(
      'Real media storage is not integrated yet',
    );
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
      orderBy: { createdAt: 'desc' },
    });
  }
}
