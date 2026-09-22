import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "crypto";

/**
 * CIFRADO DE CAMPOS: LO QUE NO HACE FALTA LEER PARA BUSCAR, NO SE GUARDA LEGIBLE.
 *
 * AES-256-GCM con una clave de entorno (DATA_ENCRYPTION_KEY, 32 bytes en
 * base64). GCM y no CBC porque además de ocultar el dato lo AUTENTICA: un valor
 * cifrado que alguien modificó en la base no se descifra a otra cosa, falla.
 *
 * ── Qué se cifra y qué no ───────────────────────────────────────────────────
 * Se cifran los datos personales que solo se abren si hay una disputa o una
 * revisión: la IP y el navegador con que se aceptó un contrato, el chasis de un
 * auto, el DNI del titular de la cédula, el número de póliza, los códigos de
 * entrega y devolución de una reserva. Quien lea la base —un backup filtrado,
 * un acceso indebido— no se lleva eso.
 *
 * NO se cifran los datos contra los que hay que buscar o garantizar unicidad
 * (email, DNI y CUIL de la cuenta): cifrarlos obligaría a un índice aparte y es
 * una decisión que ya se tomó en su momento.
 *
 * ── El formato ──────────────────────────────────────────────────────────────
 *   enc:v1:<iv base64>:<tag base64>:<datos base64>
 *
 * El prefijo con versión es lo que permite rotar la clave: un valor v1 se
 * descifra con la clave de la v1 aunque ya exista una v2. Y es lo que permite
 * convivir con datos viejos: `decrypt` sobre algo sin prefijo lo devuelve tal
 * cual, así una columna que antes guardaba texto plano se puede empezar a
 * cifrar sin migrar todo de una.
 *
 * ── Sin clave ───────────────────────────────────────────────────────────────
 * En producción, cifrar sin clave FALLA (503): guardar en claro un dato que
 * tenía que ir cifrado, en silencio, es peor que no guardarlo. En desarrollo y
 * en los tests se usa una clave fija derivada de un texto conocido, con un
 * aviso: no protege nada, pero deja que el circuito ande sin configurar nada.
 */
const PREFIJO = "enc:v1:";

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer | null;
  /** Clave anterior, solo para descifrar durante una rotación. */
  private readonly previousKey: Buffer | null;
  private readonly indexKey: Buffer | null;

  constructor(config: ConfigService) {
    this.key = this.parseKey(config.get<string>("DATA_ENCRYPTION_KEY"));
    this.previousKey = this.parseKey(
      config.get<string>("DATA_ENCRYPTION_KEY_PREVIOUS"),
    );

    const enProduccion =
      (config.get<string>("NODE_ENV") ?? process.env.NODE_ENV) === "production";

    if (!this.key && !enProduccion) {
      // No protege nada y está bien que no lo haga: es para que el proyecto
      // arranque en una máquina de desarrollo sin tener que generar una clave.
      this.key = createHash("sha256")
        .update("freewheel-dev-only-key-no-protege-nada")
        .digest();
      this.logger.warn(
        "DATA_ENCRYPTION_KEY no está configurada: se usa una clave de " +
          "desarrollo. En producción, cifrar sin clave falla.",
      );
    } else if (!this.key) {
      this.logger.error(
        "DATA_ENCRYPTION_KEY no está configurada: todo lo que tenga que " +
          "guardarse cifrado va a fallar con 503.",
      );
    }

    // La clave de los índices ciegos se deriva de la de cifrado pero es otra:
    // usar la misma clave para dos cosas distintas es la forma clásica de que
    // una debilidad en una se contagie a la otra.
    this.indexKey = this.key
      ? createHmac("sha256", this.key).update("blind-index").digest()
      : null;
  }

  /** Si hay una clave real (o de desarrollo) con la que cifrar. */
  isConfigured(): boolean {
    return this.key !== null;
  }

  encrypt(plain: string): string;
  encrypt(plain: null | undefined): null;
  encrypt(plain: string | null | undefined): string | null;
  encrypt(plain: string | null | undefined): string | null {
    if (plain === null || plain === undefined) return null;
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const datos = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIJO}${iv.toString("base64")}:${tag.toString("base64")}:${datos.toString("base64")}`;
  }

  /**
   * Descifra. Un valor sin prefijo se devuelve tal cual (dato viejo, anterior
   * al cifrado). Un valor con prefijo que no se puede descifrar LANZA: no hay
   * que devolver basura como si fuera el dato.
   */
  decrypt(value: string): string;
  decrypt(value: null | undefined): null;
  decrypt(value: string | null | undefined): string | null;
  decrypt(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!value.startsWith(PREFIJO)) return value;

    const partes = value.slice(PREFIJO.length).split(":");
    if (partes.length !== 3) {
      throw new Error("Valor cifrado con formato inválido");
    }
    const [ivB64, tagB64, datosB64] = partes;

    for (const key of [this.key, this.previousKey]) {
      if (!key) continue;
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(ivB64, "base64"),
        );
        decipher.setAuthTag(Buffer.from(tagB64, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(datosB64, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Probar con la otra clave: puede ser un valor de antes de la rotación.
      }
    }
    throw new Error(
      "No se pudo descifrar el valor: la clave cambió o el dato fue alterado",
    );
  }

  /** Descifra sin lanzar: para mostrar, donde un dato ilegible no es fatal. */
  tryDecrypt(value: string | null | undefined): string | null {
    try {
      return this.decrypt(value);
    } catch {
      return null;
    }
  }

  isEncrypted(value: string | null | undefined): boolean {
    return typeof value === "string" && value.startsWith(PREFIJO);
  }

  /**
   * Un ÍNDICE CIEGO: un hash con clave, determinístico, para poder buscar o
   * detectar repetidos sobre un dato cifrado sin descifrarlo (por ejemplo, el
   * mismo chasis en dos autos). Con clave y no un hash pelado porque un dato
   * de pocos valores posibles —un DNI— se revierte probando todos.
   */
  blindIndex(value: string): string {
    if (!this.indexKey) this.requireKey();
    return createHmac("sha256", this.indexKey as Buffer)
      .update(value.trim().toUpperCase())
      .digest("hex");
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: "ENCRYPTION_NOT_CONFIGURED",
        message:
          "El servidor no tiene configurada la clave de cifrado, así que no " +
          "puede guardar este dato de forma segura.",
      });
    }
    return this.key;
  }

  private parseKey(raw: string | undefined): Buffer | null {
    const valor = raw?.trim();
    if (!valor) return null;
    const key = Buffer.from(valor, "base64");
    if (key.length !== 32) {
      // Una clave mal cargada no se "arregla" rellenándola: se avisa y se
      // trata como ausente, que en producción es fallar cerrado.
      this.logger.error(
        "Una clave de cifrado no tiene 32 bytes en base64 (generala con " +
          "`openssl rand -base64 32`): se ignora.",
      );
      return null;
    }
    return key;
  }
}
