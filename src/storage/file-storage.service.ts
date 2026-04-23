import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

type SavePrivateFileInput = {
  buffer: Buffer;
  mimeType: string;
  originalFilename?: string;
  folder: string;
};

type StoredFile = {
  storageKey: string;
  mimeType: string;
  originalFilename?: string;
  fileSize: number;
};

@Injectable()
export class FileStorageService {
  async savePrivateFile(input: SavePrivateFileInput): Promise<StoredFile> {
    const baseDir = process.env.LOCAL_UPLOADS_DIR || 'uploads';
    const fileExtension = this.extensionForMimeType(input.mimeType);
    const fileName = `${randomUUID()}${fileExtension}`;
    const storageKey = `${input.folder}/${fileName}`.replace(/\\/g, '/');
    const absolutePath = join(process.cwd(), baseDir, storageKey);

    try {
      await mkdir(join(process.cwd(), baseDir, input.folder), {
        recursive: true,
      });
      await writeFile(absolutePath, input.buffer);
    } catch (error) {
      console.error('Error guardando archivo privado', error);
      throw new InternalServerErrorException(
        'No se pudo guardar el archivo subido.',
      );
    }

    return {
      storageKey,
      mimeType: input.mimeType,
      originalFilename: input.originalFilename,
      fileSize: input.buffer.length,
    };
  }

  async deleteFile(storageKey: string) {
    const baseDir = process.env.LOCAL_UPLOADS_DIR || 'uploads';
    const absolutePath = join(process.cwd(), baseDir, storageKey);

    try {
      await rm(absolutePath, { force: true });
    } catch (error) {
      console.error('Error eliminando archivo privado', error);
      throw new InternalServerErrorException(
        'No se pudo reemplazar el archivo anterior.',
      );
    }
  }

  private extensionForMimeType(mimeType: string) {
    switch (mimeType) {
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      case 'image/jpeg':
      default:
        return '.jpg';
    }
  }
}
