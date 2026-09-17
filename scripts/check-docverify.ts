import "dotenv/config";

/**
 * ¿POR QUÉ NO LLEGA EL BACKEND A LA API DE LECTURA?
 *
 * Existe porque el síntoma de este problema es siempre el mismo —"fetch
 * failed"— y las causas son varias y se arreglan distinto: la variable sin
 * protocolo, uvicorn escuchando en otra interfaz, el token que no coincide,
 * un backend desplegado apuntando a una dirección de tu casa. Este script
 * prueba la cadena entera en orden y dice cuál eslabón falló y qué cambiar.
 *
 *   npm run check:docverify
 *
 * Son cuatro cosas, y si falta una la verificación no anda:
 *
 *   1. Cloudinary, que es donde viven las fotos del documento.
 *   2. Que se llegue a la API de lectura.
 *   3. Que acepte el token.
 *   4. Que tenga a dónde devolver el resultado cuando termina.
 *
 * No toca la base ni manda fotos: pega en /health, en /contrato y en el ping
 * de Cloudinary.
 */

/** Cuánto se espera a cada pedido. El arranque en frío puede ser lento. */
const TIMEOUT_MS = Number(process.env.DOCVERIFY_TIMEOUT_MS ?? 15_000);

const ok = (t: string) => console.log(`  OK    ${t}`);
const mal = (t: string) => console.log(`  FALLA ${t}`);
const nota = (t: string) => console.log(`        ${t}`);

/** Cosas que andan pero no deberían quedar así. Se listan al final. */
const avisos: string[][] = [];

/** ¿Es un host de la misma máquina o de la red local? */
function esLocal(host: string): boolean {
  const limpio = host.replace(/^\[|\]$/g, "");
  return (
    limpio === "localhost" ||
    limpio.endsWith(".localhost") ||
    limpio === "::1" ||
    limpio === "0.0.0.0" ||
    /^127\./.test(limpio) ||
    /^10\./.test(limpio) ||
    /^192\.168\./.test(limpio) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(limpio)
  );
}

/** El mensaje completo, desarmando la cadena de `cause` (ver el cliente). */
function describe(error: unknown): string {
  const partes: string[] = [];
  const vistos = new Set<unknown>();
  let actual: unknown = error;

  while (actual instanceof Error && !vistos.has(actual)) {
    vistos.add(actual);
    const codigo = (actual as NodeJS.ErrnoException).code;
    const texto =
      typeof codigo === "string" && codigo && !actual.message.includes(codigo)
        ? `${actual.message} (${codigo})`
        : actual.message;
    if (texto && !partes.includes(texto)) partes.push(texto);
    const agrupados = (actual as AggregateError).errors;
    actual =
      actual.cause ??
      (Array.isArray(agrupados) && agrupados.length > 0 ? agrupados[0] : null);
  }
  if (typeof actual === "string" && actual) partes.push(actual);
  return partes.length > 0 ? partes.join(": ") : String(error);
}

async function pedir(url: string, headers: Record<string, string> = {}) {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: corte.signal });
  } finally {
    clearTimeout(reloj);
  }
}

async function main(): Promise<void> {
  const crudo = (process.env.DOCVERIFY_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.DOCVERIFY_TOKEN ?? "").trim();
  const plataforma = (process.env.DOCVERIFY_PLATFORM_TOKEN ?? "").trim();

  console.log("\nVerificación de documentos\n");

  // ── 0. Cloudinary ──────────────────────────────────────────────────────────
  // Va primero porque sin esto no hay verificación posible, ni automática ni
  // manual: las fotos se suben ahí y de ahí las baja el backend para mandarlas
  // a analizar. Sin las tres variables, subir un documento devuelve 503.
  const nube = (process.env.CLOUDINARY_CLOUD_NAME ?? "").trim();
  const clave = (process.env.CLOUDINARY_API_KEY ?? "").trim();
  const secreto = (process.env.CLOUDINARY_API_SECRET ?? "").trim();

  if (!nube || !clave || !secreto) {
    const faltan = [
      !nube && "CLOUDINARY_CLOUD_NAME",
      !clave && "CLOUDINARY_API_KEY",
      !secreto && "CLOUDINARY_API_SECRET",
    ].filter(Boolean);
    mal(`falta ${faltan.join(", ")}`);
    nota("Ahí viven las fotos de los documentos: sin esto no se puede subir");
    nota("ninguna, y la verificación no arranca. Las tres salen del panel de");
    nota("Cloudinary (Dashboard → API Keys).");
    process.exitCode = 1;
    return;
  }

  try {
    const credencial = Buffer.from(`${clave}:${secreto}`).toString("base64");
    const ping = await pedir(`https://api.cloudinary.com/v1_1/${nube}/ping`, {
      Authorization: `Basic ${credencial}`,
    });
    if (ping.ok) {
      ok(`Cloudinary responde y acepta las credenciales (${nube})`);
    } else {
      mal(`Cloudinary rechazó las credenciales (HTTP ${ping.status})`);
      nota("Revisá CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET, y que sean de");
      nota(`la cuenta "${nube}".`);
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    mal(`no se pudo hablar con Cloudinary: ${describe(error)}`);
    process.exitCode = 1;
    return;
  }

  // ── 1. La variable ─────────────────────────────────────────────────────────
  if (!crudo) {
    mal("DOCVERIFY_URL está vacía");
    nota("Sin esto no hay lectura automática: los documentos se guardan y los");
    nota("revisa un administrador. Para encenderla, en tu .env:");
    nota('  DOCVERIFY_URL="http://127.0.0.1:8000"');
    process.exitCode = 1;
    return;
  }

  // El mismo arreglo que hace el cliente: `localhost:8000` sin protocolo no es
  // host+puerto para fetch, es un esquema llamado "localhost".
  const tieneProtocolo = /^[a-z][a-z0-9+.-]*:\/\//i.test(crudo);
  let base = crudo;
  if (!tieneProtocolo) {
    let host: string | null = null;
    try {
      host = new URL(`http://${crudo}`).hostname;
    } catch {
      host = null;
    }
    base = `${host !== null && esLocal(host) ? "http" : "https"}://${crudo}`;
    ok(`DOCVERIFY_URL="${crudo}" (sin protocolo; se usa ${base})`);
    nota("Conviene escribirla completa en el .env para que no haya dudas.");
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch (error) {
    mal(`DOCVERIFY_URL no es una URL: ${describe(error)}`);
    nota('Tiene que ser algo como "http://127.0.0.1:8000".');
    process.exitCode = 1;
    return;
  }
  if (tieneProtocolo) ok(`DOCVERIFY_URL = ${base}`);

  const local = esLocal(url.hostname);
  if (local && (process.env.VERCEL || process.env.VERCEL_URL)) {
    mal(`${url.hostname} es una dirección privada y esto corre en Vercel`);
    nota("Un backend desplegado no tiene ruta hasta tu máquina. Opciones en");
    nota("docverify-api/README.md (exponerla con un túnel, o desplegarla).");
    process.exitCode = 1;
    return;
  }

  // ── 2. La conexión ─────────────────────────────────────────────────────────
  let salud: Response;
  try {
    salud = await pedir(`${base}/health`);
    ok(`responde en ${base}/health (HTTP ${salud.status})`);
  } catch (error) {
    const detalle = describe(error);
    mal(`no se pudo conectar: ${detalle}`);

    if (/ECONNREFUSED/.test(detalle)) {
      nota("Hay ruta hasta ahí, pero nada escuchando en ese puerto.");
      if (local) {
        nota("Levantá la API en la carpeta docverify-api/:");
        nota(
          `  .venv/bin/python -m uvicorn app.main:app --port ${url.port || "8000"}`,
        );
        nota("  (Windows: .venv\\Scripts\\python -m uvicorn ...)");
        nota("Si ya está corriendo, fijate que el puerto sea el mismo, y que");
        nota("uvicorn no esté escuchando solo en ::1 o en otra interfaz.");
      }
    } else if (/ENOTFOUND|EAI_AGAIN/.test(detalle)) {
      nota("Ese nombre no resuelve: revisá que esté bien escrito.");
    } else if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(detalle)) {
      nota("No hay ruta hasta ahí (firewall, o una red que no es la tuya).");
    } else if (/abort/i.test(detalle)) {
      nota(`No contestó en ${TIMEOUT_MS / 1000}s. Si recién arranca, puede`);
      nota("estar cargando el motor de OCR: probá de nuevo en un momento.");
    }
    process.exitCode = 1;
    return;
  }

  const cuerpo = (await salud.text()).slice(0, 300);
  let protegida = false;
  try {
    const datos = JSON.parse(cuerpo) as { protegido_con_token?: unknown };
    protegida = Boolean(datos.protegido_con_token);
    ok(`la API pide token: ${protegida ? "sí" : "no"}`);
  } catch {
    nota(`/health contestó algo que no es JSON: ${cuerpo}`);
  }

  // ── 3. El token ────────────────────────────────────────────────────────────
  if (protegida && !token) {
    mal("la API pide token y DOCVERIFY_TOKEN está vacía");
    nota("Poné en el .env del backend el MISMO valor que tiene la API:");
    nota('  DOCVERIFY_TOKEN="<el mismo de docverify-api/.env>"');
    process.exitCode = 1;
    return;
  }
  if (!protegida && !local) {
    // El caso del túnel, y es el peligroso: la API corre en una máquina, así
    // que ninguna señal de plataforma está puesta y se cree en local —arranca
    // sin token y con CORS abierto— pero la URL la alcanza cualquiera. Por acá
    // pasan documentos de identidad de personas reales.
    avisos.push([
      "La API es alcanzable desde internet y NO pide token: cualquiera que",
      "sepa la URL puede mandarle documentos. Si la estás exponiendo con un",
      "túnel, levantala así (la variable la obliga a exigir token):",
      '  DOCVERIFY_EXPUESTO=1 DOCVERIFY_TOKEN="<un secreto largo>" \\',
      "    .venv/bin/python -m uvicorn app.main:app --port 8000",
      "y poné el MISMO DOCVERIFY_TOKEN en el backend.",
    ]);
  } else if (!protegida && token) {
    nota("DOCVERIFY_TOKEN está puesta pero la API no pide token: sobra, y no");
    nota("molesta. Corriendo en local no hace falta.");
  }

  // /contrato pasa por el mismo control de token que /analizar/documento, así
  // que sirve para probar la credencial sin mandar ninguna foto.
  const headers: Record<string, string> = {};
  if (token) headers["X-Docverify-Token"] = token;
  if (plataforma) headers.Authorization = `Bearer ${plataforma}`;
  else if (token) headers.Authorization = `Bearer ${token}`;

  const contrato = await pedir(`${base}/contrato`, headers);
  if (contrato.status === 401 || contrato.status === 403) {
    mal(`la API rechazó el token (HTTP ${contrato.status})`);
    nota(
      "DOCVERIFY_TOKEN tiene que ser EXACTAMENTE el mismo de los dos lados.",
    );
    if (plataforma)
      nota("Revisá también que DOCVERIFY_PLATFORM_TOKEN siga válido.");
    process.exitCode = 1;
    return;
  }
  if (!contrato.ok) {
    mal(`/contrato contestó HTTP ${contrato.status}`);
    process.exitCode = 1;
    return;
  }
  ok("el token es aceptado");

  // ── 4. La vuelta ───────────────────────────────────────────────────────────
  // El análisis tarda más que un request: el resultado vuelve por acá. Si esta
  // URL no es alcanzable desde donde corre la API, el análisis se hace y se
  // pierde.
  const publica =
    (process.env.PUBLIC_URL ?? "").trim() ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
    (process.env.NODE_ENV !== "production"
      ? `http://localhost:${process.env.PORT ?? "3000"}`
      : "");

  if (!publica) {
    mal("no hay PUBLIC_URL ni VERCEL_URL: el análisis ni se pide");
    nota("La API no tendría a dónde devolver el resultado.");
    process.exitCode = 1;
    return;
  }
  ok(`el resultado vuelve a ${publica}`);
  if (local && !esLocal(new URL(publica).hostname)) {
    nota("Ojo: la API corre en tu máquina y el callback apunta afuera.");
  }

  // Que la URL exista no alcanza: tiene que ser ALCANZABLE SIN CREDENCIALES,
  // porque quien la llama es la API de lectura y no tiene ninguna. El caso que
  // este chequeo existe para cazar es la Deployment Protection de Vercel, que
  // viene activada y contesta 401 "Protected deployment" a cualquiera sin su
  // cookie de sesión. El síntoma sin esto es el peor de todos: el documento se
  // lee perfecto y el resultado se pierde en silencio, cada vez.
  if (!esLocal(new URL(publica).hostname)) {
    const callback = `${publica}/verification/identity/analysis-callback`;
    try {
      // Sin token: se espera un 401 DEL BACKEND (token inválido), que confirma
      // que el pedido llegó. Lo que se busca es distinguir ese 401 del de la
      // plataforma, que ni siquiera deja pasar el request.
      const prueba = await pedir(callback, {});
      const cuerpoPrueba = (await prueba.text()).slice(0, 400);
      const muroDePlataforma =
        /vercel_auth_enabled|Protected deployment|sso-api|Authentication Required/i.test(
          cuerpoPrueba,
        );

      if (muroDePlataforma) {
        mal("la URL del callback está detrás del login de la plataforma");
        nota("La API de lectura no tiene cómo pasar ese login: el análisis se");
        nota("hace, el aviso vuelve con 401 y el resultado se pierde.");
        nota("En Vercel: Settings → Deployment Protection → desactivá Vercel");
        nota("Authentication, o apuntá PUBLIC_URL al dominio de producción");
        nota("(no a la URL del deploy, que es la que queda protegida).");
        process.exitCode = 1;
        return;
      }
      ok(`el callback es alcanzable sin credenciales (HTTP ${prueba.status})`);
    } catch (error) {
      mal(`no se pudo alcanzar la URL del callback: ${describe(error)}`);
      nota(`Tiene que responder desde internet: ${callback}`);
      process.exitCode = 1;
      return;
    }
  }

  if (avisos.length > 0) {
    for (const aviso of avisos) {
      console.log("\n  AVISO " + aviso[0]);
      for (const linea of aviso.slice(1)) nota(linea);
    }
    console.log(
      "\nLa cadena funciona, pero revisá el aviso de arriba antes de dejarlo así.\n",
    );
    return;
  }

  console.log(
    "\nTodo listo: subí un documento y en ~10 segundos cambia solo de estado.\n",
  );
}

main().catch((error) => {
  console.error(`\nError inesperado: ${describe(error)}\n`);
  process.exitCode = 1;
});
