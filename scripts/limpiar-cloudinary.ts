/**
 * LIMPIEZA DE ARCHIVOS HUÉRFANOS EN CLOUDINARY
 *
 * Borra lo que quedó colgado de cuentas de prueba: documentos de identidad de
 * usuarios que ya no existen, fotos de avisos borrados, subidas que nunca se
 * llegaron a enviar. Un archivo se considera huérfano cuando NINGUNA fila de
 * la base lo referencia:
 *
 *   identity/<userId>/<slot>_...  → DocumentVerification.frontUrl / backUrl
 *   <resto>                       → MediaAsset.url, User.profilePhotoUrl,
 *                                   Contract.pdfUrl
 *
 * Además, si la carpeta `identity/<userId>` es de un usuario que ya no está en
 * la tabla User, el archivo es huérfano aunque sea reciente.
 *
 * Uso:
 *   npm run cloudinary:limpiar              → simulación, no borra nada
 *   npm run cloudinary:limpiar -- --apply   → borra
 *   ... -- --horas 48   margen para subidas en curso (default 24)
 *   ... -- --prefijo identity/   limita la pasada a una carpeta
 *
 * Necesita CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET y DATABASE_URL en el .env
 * del entorno cuyos archivos se quieren limpiar (los del deploy, no los de un
 * .env vacío de desarrollo).
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

config({ path: resolve(process.cwd(), ".env") });

const APLICAR = process.argv.includes("--apply");
const HORAS = Number(leerOpcion("--horas") ?? 24);
const PREFIJOS = (leerOpcion("--prefijo") ?? "identity/,freewheel/").split(",");

/** Los dos tipos de entrega que usa el proyecto. */
const TIPOS = [
  { deliveryType: "authenticated", prefijoPropio: "identity/" },
  { deliveryType: "upload", prefijoPropio: "" },
] as const;

interface Recurso {
  public_id: string;
  format: string;
  created_at: string;
  bytes: number;
  type: string;
}

function leerOpcion(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function credenciales() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Faltan CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET en el .env. " +
        "Copiá los del entorno cuyos archivos querés limpiar.",
    );
  }
  return { cloudName, apiKey, apiSecret };
}

async function admin(path: string, init?: RequestInit) {
  const { cloudName, apiKey, apiSecret } = credenciales();
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  const respuesta = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}${path}`,
    { ...init, headers: { Authorization: `Basic ${auth}`, ...init?.headers } },
  );
  if (!respuesta.ok) {
    throw new Error(
      `Cloudinary Admin API ${path} respondió ${respuesta.status}: ` +
        (await respuesta.text()).slice(0, 300),
    );
  }
  return respuesta.json() as Promise<Record<string, unknown>>;
}

/** Inventario completo de una carpeta, siguiendo la paginación. */
async function listar(deliveryType: string, prefix: string) {
  const recursos: Recurso[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({
      type: deliveryType,
      prefix,
      max_results: "500",
    });
    if (cursor) query.set("next_cursor", cursor);
    const pagina = await admin(`/resources/image?${query}`);
    recursos.push(...((pagina.resources as Recurso[]) ?? []));
    cursor = pagina.next_cursor as string | undefined;
  } while (cursor);
  return recursos;
}

/** public_id de una URL de Cloudinary, sin firma, versión ni extensión. */
function publicIdDeUrl(url: string | null): string | null {
  if (!url) return null;
  const match =
    /res\.cloudinary\.com\/[^/]+\/image\/[^/]+\/(?:s--[A-Za-z0-9_-]+--\/)?(?:v\d+\/)?(.+?)(?:\.[A-Za-z0-9]+)?$/.exec(
      url,
    );
  return match ? match[1] : null;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    // ── Todo lo que la base dice que está en uso ────────────────────────────
    const enUso = new Set<string>();
    const anotar = (url: string | null) => {
      const id = publicIdDeUrl(url);
      if (id) enUso.add(id);
    };

    const documentos = await prisma.documentVerification.findMany({
      select: { frontUrl: true, backUrl: true },
    });
    documentos.forEach((d) => {
      anotar(d.frontUrl);
      anotar(d.backUrl);
    });

    (await prisma.mediaAsset.findMany({ select: { url: true } })).forEach((m) =>
      anotar(m.url),
    );
    (
      await prisma.user.findMany({
        where: { profilePhotoUrl: { not: null } },
        select: { profilePhotoUrl: true },
      })
    ).forEach((u) => anotar(u.profilePhotoUrl));
    (
      await prisma.contract.findMany({
        where: { pdfUrl: { not: null } },
        select: { pdfUrl: true },
      })
    ).forEach((c) => anotar(c.pdfUrl));

    const usuarios = new Set(
      (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id),
    );

    console.log(
      `Referencias vivas en la base: ${enUso.size} archivos · usuarios: ${usuarios.size}`,
    );

    // ── Inventario en Cloudinary ────────────────────────────────────────────
    const corte = Date.now() - HORAS * 3600_000;
    const huerfanos: (Recurso & { motivo: string })[] = [];
    let total = 0;

    for (const { deliveryType, prefijoPropio } of TIPOS) {
      for (const prefijo of PREFIJOS) {
        if (prefijoPropio && !prefijo.startsWith(prefijoPropio)) continue;
        if (!prefijoPropio && prefijo.startsWith("identity/")) continue;

        const recursos = await listar(deliveryType, prefijo);
        total += recursos.length;
        for (const recurso of recursos) {
          if (enUso.has(recurso.public_id)) continue;

          const duenio = /^identity\/([^/]+)\//.exec(recurso.public_id)?.[1];
          const duenioBorrado = Boolean(duenio) && !usuarios.has(duenio!);
          const reciente = new Date(recurso.created_at).getTime() > corte;

          // Una subida reciente puede ser un flujo a medio hacer: se respeta,
          // salvo que su dueño ya no exista.
          if (reciente && !duenioBorrado) continue;

          huerfanos.push({
            ...recurso,
            type: deliveryType,
            motivo: duenioBorrado
              ? "el usuario de la carpeta ya no existe"
              : "ninguna fila de la base lo referencia",
          });
        }
      }
    }

    const bytes = huerfanos.reduce((suma, r) => suma + (r.bytes ?? 0), 0);
    console.log(
      `\n${APLICAR ? "BORRANDO" : "SIMULACIÓN"} · ${huerfanos.length} huérfanos de ${total} archivos ` +
        `(${(bytes / 1024 / 1024).toFixed(1)} MB)\n`,
    );
    huerfanos.forEach((r) =>
      console.log(
        `  ${r.type.padEnd(13)} ${r.public_id}.${r.format}  — ${r.motivo} (${r.created_at.slice(0, 10)})`,
      ),
    );

    if (!APLICAR) {
      console.log("\nNada se borró. Para ejecutar: -- --apply");
      return;
    }

    let borrados = 0;
    for (const recurso of huerfanos) {
      const query = new URLSearchParams({
        "public_ids[]": recurso.public_id,
        type: recurso.type,
      });
      await admin(`/resources/image?${query}`, { method: "DELETE" });
      borrados += 1;
    }
    console.log(`\nBorrados ${borrados} archivos.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error(`\nFalló: ${mensaje}`);
  if (mensaje.includes("SELF_SIGNED_CERT_IN_CHAIN")) {
    console.error(
      "Tu red intercepta el TLS: exportá NODE_EXTRA_CA_CERTS con el certificado " +
        "raíz de la empresa, o corré esto desde otra red.",
    );
  }
  process.exit(1);
});
