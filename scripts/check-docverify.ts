import "dotenv/config";

/**
 * ¿POR QUÉ NO LLEGA EL BACKEND A LA API DE LECTURA?
 *
 * Existe porque el síntoma de este problema es siempre el mismo —"fetch
 * failed"— y las causas son varias y se arreglan distinto: la variable sin
 * protocolo, uvicorn escuchando en otra interfaz, el token que no coincide,
 * un backend desplegado apuntando a una dirección de tu casa. Este script
 * prueba las tres cosas en orden y dice cuál falló y qué cambiar.
 *
 *   npm run check:docverify
 *
 * No toca la base ni manda fotos: solo pega en /health y en /contrato.
 */

/** Cuánto se espera a cada pedido. El arranque en frío puede ser lento. */
const TIMEOUT_MS = Number(process.env.DOCVERIFY_TIMEOUT_MS ?? 15_000);

const ok = (t: string) => console.log(`  OK    ${t}`);
const mal = (t: string) => console.log(`  FALLA ${t}`);
const nota = (t: string) => console.log(`        ${t}`);

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

  console.log("\nAPI de lectura de documentos (docverify)\n");

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
  if (!protegida && token) {
    nota("DOCVERIFY_TOKEN está puesta pero la API no pide token: sobra, y no");
    nota("molesta. En un deploy expuesto a internet, ponéselo también a ella.");
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

  console.log("\nTodo listo: la lectura automática debería funcionar.\n");
}

main().catch((error) => {
  console.error(`\nError inesperado: ${describe(error)}\n`);
  process.exitCode = 1;
});
