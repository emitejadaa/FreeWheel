/**
 * La firma de subida: que UNA firma sirva para UNA foto.
 *
 * Esta prueba cuida la propiedad de la que depende el tope diario de fotos.
 * Si la firma volviera a ser por carpeta, pedir una sola y repetir la subida
 * desde la consola del navegador llenaría la cuenta de Cloudinary sin pasar
 * por el servidor otra vez, y el tope de media.controller.ts dejaría de
 * limitar nada sin que ningún test se queje.
 */
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "./media.service";

const ENV: Record<string, string> = {
  CLOUDINARY_CLOUD_NAME: "demo-cloud",
  CLOUDINARY_API_KEY: "key123",
  CLOUDINARY_API_SECRET: "secret456",
};

const service = (env: Record<string, string | undefined> = ENV) =>
  new MediaService(
    {} as unknown as PrismaService,
    { get: (key: string) => env[key] } as unknown as ConfigService,
  );

describe("MediaService.signUpload", () => {
  it("LA FIRMA ES DE UN ARCHIVO, NO DE UNA CARPETA", () => {
    const firmada = service().signUpload("user-1", "freewheel");

    // El nombre del archivo lo pone el servidor, con la cuenta adentro.
    expect(firmada.publicId).toMatch(/^freewheel\/user-1\/\d+_[0-9a-f]{8}$/);

    // Y es lo que se firma: Cloudinary solo va a aceptar una subida a ESE
    // nombre. Repetirla sobrescribe el mismo archivo en vez de sumar otro.
    const esperada = createHash("sha1")
      .update(
        `public_id=${firmada.publicId}&timestamp=${firmada.timestamp}secret456`,
      )
      .digest("hex");
    expect(firmada.signature).toBe(esperada);
  });

  it("no manda el folder junto con el public_id", () => {
    // El public_id ya trae la carpeta adentro. Mandar los dos hace que
    // Cloudinary la anteponga otra vez y el archivo termine en
    // freewheel/freewheel/user-1/... Es el mismo error que ya se cometió una
    // vez con los documentos de identidad.
    const { params } = service().signUpload("user-1");
    expect(Object.keys(params).sort()).toEqual([
      "api_key",
      "public_id",
      "signature",
      "timestamp",
    ]);
  });

  it("dos firmas seguidas no se pisan entre ellas", () => {
    // Si el nombre fuera solo la fecha, dos fotos del mismo segundo irían al
    // mismo archivo y la segunda borraría la primera.
    const una = service().signUpload("user-1");
    const otra = service().signUpload("user-1");
    expect(una.publicId).not.toBe(otra.publicId);
  });

  it("cada cuenta sube a su propio lugar", () => {
    expect(service().signUpload("user-1").publicId).toContain("/user-1/");
    expect(service().signUpload("user-2").publicId).toContain("/user-2/");
  });

  it("las carpetas reservadas siguen cerradas", () => {
    // identity/ y vehicle-docs/ tienen su propia firma, que sube los archivos
    // como privados. Entrar por acá sería dejarlos públicos.
    for (const carpeta of [
      "identity",
      "identity/user-1",
      "IDENTITY",
      "/identity",
      "vehicle-docs",
    ]) {
      expect(() => service().signUpload("user-1", carpeta)).toThrow(
        BadRequestException,
      );
    }
  });

  it("sin credenciales no inventa una firma", () => {
    expect(() => service({}).signUpload("user-1")).toThrow(
      ServiceUnavailableException,
    );
  });
});
