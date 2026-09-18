import { Injectable } from "@nestjs/common";
import { User, VerifiedDocumentType } from "@prisma/client";
import { DocverifyField, DocverifyResult } from "./docverify.client";
import { esLaCuentaDePrueba } from "../../common/cuenta-de-prueba";
import {
  fieldLabel,
  VerificationReason,
  verificationReason,
} from "../errors/verification-reasons";

/**
 * EL CRUCE: ¿ESTE DOCUMENTO ES COHERENTE, Y ES DE ESTA PERSONA?
 *
 * La API de lectura dice qué leyó y con qué confianza, pero no sabe quién es
 * el usuario ni tiene opinión sobre si algo está bien. Acá se toma esa lectura
 * y se responde lo único que importa: si el documento se puede aprobar solo.
 *
 * ── Las tres preguntas, en orden ─────────────────────────────────────────────
 *
 * 1. ¿EL DOCUMENTO DICE LO MISMO EN TODAS PARTES? Un DNI trae el apellido
 *    impreso, adentro del PDF417 y adentro de la MRZ. Los tres tienen que
 *    coincidir. Cuando alguien altera una tarjeta cambia lo impreso, que es lo
 *    visible, y el código sigue diciendo el dato original: esa contradicción es
 *    la firma del fraude, y compararlos es lo único que la muestra.
 *
 * 2. ¿COINCIDE CON LA CUENTA? De nada sirve un documento perfectamente
 *    coherente si es de otra persona. Nombre, apellido, DNI, nacimiento y CUIL
 *    se comparan contra lo que el usuario cargó en su perfil.
 *
 * 3. ¿HABILITA? Una licencia legítima y del titular igual no sirve si venció o
 *    si es de moto. Eso no invalida el documento —se aprueba igual, porque ES
 *    su licencia— pero queda anotado y es lo que después impide alquilar.
 *
 * ── La regla que gobierna todo: NUNCA RECHAZAR SOLO ─────────────────────────
 * El veredicto posible es APPROVE o MANUAL_REVIEW. No hay REJECT automático, y
 * es deliberado: el costo de los dos errores no es el mismo. Aprobar de más lo
 * atrapa después el control antifraude del número de documento y la revisión
 * del admin; rechazar de menos echa a una persona real por una foto con
 * reflejo, sin que nadie lo mire. Un OCR equivocándose no puede ser la última
 * palabra sobre la identidad de alguien.
 *
 * Por eso mismo un dato que NO SE PUDO LEER no es un dato que no coincide: es
 * una foto para volver a mirar, y va a revisión manual.
 *
 * ── Y la que gobierna la comparación: normalizar antes ──────────────────────
 * "TEJADA ARAGON" y "Tejada Aragón" son la misma persona. Comparar los textos
 * crudos produciría un desacuerdo por cada tilde y por cada espacio de más, o
 * sea una avalancha de revisiones manuales sobre documentos perfectos. Se
 * compara normalizado (ver `mismoTexto`), y el valor original queda guardado
 * para poder auditar qué se comparó contra qué.
 */

/** Campos que se cruzan entre sí y contra la cuenta. */
const CAMPOS_DE_IDENTIDAD = [
  "numero_documento",
  "apellido",
  "nombre",
  "fecha_nacimiento",
  "cuil",
  "numero_licencia",
  "sexo",
] as const;

/**
 * Qué campo del perfil contrasta cada dato del documento.
 *
 * `sexo` no está y no es un olvido: la cuenta no lo guarda. Se cruza igual
 * ENTRE orígenes —si el texto impreso dice F y el código dice M, la tarjeta
 * está alterada— pero no hay contra qué compararlo del lado de la cuenta.
 */
/**
 * Los campos de User que se pueden contrastar contra un dato leído: los de
 * texto y los de fecha.
 *
 * Está acotado con un tipo y no con un comentario porque es lo que le permite
 * a la comparación tratar el valor como `string | Date | null` sin castear.
 * Apuntar el mapa de abajo a un campo que sea un objeto —una relación, un
 * Json— no compila, que es exactamente cuándo conviene enterarse.
 */
type CampoComparable = {
  [K in keyof User]: User[K] extends string | Date | null ? K : never;
}[keyof User];

const CAMPO_DE_LA_CUENTA: Partial<
  Record<(typeof CAMPOS_DE_IDENTIDAD)[number], CampoComparable>
> = {
  numero_documento: "dni",
  apellido: "lastName",
  nombre: "firstName",
  fecha_nacimiento: "dateOfBirth",
  cuil: "cuil",
};

/**
 * Qué campos tiene que traer cada documento sí o sí para poder aprobarlo solo.
 *
 * Es el juego mínimo con el que la aprobación significa algo. Si falta alguno,
 * el documento no se rechaza: lo mira un admin, que puede leer con los ojos lo
 * que el OCR no pudo.
 */
const IMPRESCINDIBLES: Record<VerifiedDocumentType, string[]> = {
  DNI: ["numero_documento", "apellido", "nombre", "fecha_nacimiento"],
  LICENSE: ["apellido", "nombre", "fecha_vencimiento"],
};

/**
 * Las clases de licencia argentinas que habilitan a conducir un auto
 * particular.
 *
 * B es la de auto. C (camiones), D (transporte de pasajeros) y E (con
 * acoplado) son profesionales y, según el régimen nacional, para obtenerlas
 * hay que tener ya la B: quien tiene una de esas puede manejar un auto. A es
 * de moto y por sí sola NO habilita, que es justamente el caso que hoy pasaría
 * desapercibido.
 *
 * Se compara por la LETRA inicial porque la clase viene subdividida ("B.1",
 * "B.2", "C.3") y las subdivisiones no cambian si se puede manejar un auto o
 * no.
 */
const CLASES_QUE_HABILITAN_AUTO = new Set(["B", "C", "D", "E"]);

/** Lo que se decidió sobre un campo, y qué lo sostiene. */
export interface FieldVerdict {
  /** El valor acordado, o el más leído si hubo desacuerdo. */
  value: string;
  /** Quiénes lo leyeron: "frente.ocr", "dorso.mrz"... */
  sources: string[];
  /** Todas las lecturas distintas que aparecieron. */
  values: string[];
  /** Si todos los que lo leyeron dijeron lo mismo. */
  agrees: boolean;
  /** Si más de un origen independiente lo confirmó. */
  corroborated: boolean;
  /** Si coincide con la cuenta. `null` = la cuenta no tiene con qué comparar. */
  matchesAccount: boolean | null;
}

/** Lo que la lectura descubrió y el perfil no tenía. */
export interface ExtractedFacts {
  /** Vencimiento del documento analizado. */
  expiresAt: Date | null;
  /** Solo para la licencia. */
  licenseClass: string | null;
  licenseIssuedAt: Date | null;
  licenseBeginnerUntil: Date | null;
  /** El número que el documento dice tener, leído de la foto. */
  documentNumber: string | null;
}

export interface IdentityMatchReport {
  verdict: "APPROVE" | "MANUAL_REVIEW";
  reasons: VerificationReason[];
  fields: Record<string, FieldVerdict>;
  facts: ExtractedFacts;
  /** Lo que la API dijo sobre sí misma, para auditar después. */
  analysis: { version: string; ms: number; ok: boolean };
  checkedAt: string;
}

@Injectable()
export class IdentityMatchService {
  /**
   * El veredicto completo sobre un documento leído.
   *
   * Devuelve SIEMPRE un informe: no lanza. Un análisis que no leyó nada es un
   * informe con verdict MANUAL_REVIEW y el motivo adentro, no una excepción.
   */
  evaluate(
    type: VerifiedDocumentType,
    result: DocverifyResult,
    user: User,
  ): IdentityMatchReport {
    const lecturas = recolectarLecturas(result);
    const fields: Record<string, FieldVerdict> = {};
    const reasons: VerificationReason[] = [];

    // ── 1 y 2: coherencia interna y contra la cuenta ─────────────────────
    for (const campo of CAMPOS_DE_IDENTIDAD) {
      const porOrigen = lecturas[campo];
      if (!porOrigen || Object.keys(porOrigen).length === 0) continue;

      const veredicto = evaluarCampo(campo, porOrigen, user);
      fields[campo] = veredicto;

      if (!veredicto.agrees) {
        reasons.push(
          verificationReason("DATO_NO_COINCIDE_ENTRE_ORIGENES", {
            field: campo,
            label: fieldLabel(campo),
            values: veredicto.values,
          }),
        );
      } else if (veredicto.matchesAccount === false) {
        reasons.push(
          verificationReason("DATO_NO_COINCIDE_CON_LA_CUENTA", {
            field: campo,
            label: fieldLabel(campo),
            values: [veredicto.value],
          }),
        );
      }
    }

    // Los campos que hacen falta para que aprobar signifique algo.
    for (const campo of IMPRESCINDIBLES[type]) {
      const leido = fields[campo]?.value || valorDe(lecturas[campo]);
      if (!leido) {
        reasons.push(
          verificationReason("DATO_ILEGIBLE", {
            field: campo,
            label: fieldLabel(campo),
          }),
        );
      }
    }

    reasons.push(...this.controlesEstructurales(type, lecturas, fields));

    // ── 3: qué habilita este documento ───────────────────────────────────
    const facts = extraerHechos(type, lecturas, fields);
    reasons.push(...this.controlesDeVigencia(type, facts));

    // Cualquier motivo manda a revisión manual. No hay motivos "leves": si
    // algo no cerró, lo mira una persona. Lo que sí hay son motivos que no
    // impiden aprobar —los de habilitación— y esos se filtran acá.
    const algoNoCerro = reasons.some((r) => !NO_IMPIDEN_APROBAR.has(r.code));

    // FASE DE PRUEBA · borrar junto con cuenta-de-prueba.ts (ver ese archivo).
    // El análisis ya se hizo entero y los motivos quedan en `reasons` tal cual
    // salieron: lo único que esto cambia es el veredicto.
    const esPrueba = esLaCuentaDePrueba(user.email);

    return {
      verdict: algoNoCerro && !esPrueba ? "MANUAL_REVIEW" : "APPROVE",
      reasons,
      fields,
      facts,
      analysis: {
        version: result.version ?? "",
        ms: result.ms ?? 0,
        ok: Boolean(result.ok),
      },
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Los controles que no comparan un valor contra otro sino que miran si el
   * documento tiene sentido consigo mismo.
   */
  private controlesEstructurales(
    type: VerifiedDocumentType,
    lecturas: Lecturas,
    fields: Record<string, FieldVerdict>,
  ): VerificationReason[] {
    const reasons: VerificationReason[] = [];

    // La MRZ tiene que decir que esto es un documento de identidad argentino.
    // Se controla solo si se pudo leer: que no haya MRZ es un problema de
    // legibilidad, y ese ya lo reportó IMPRESCINDIBLES.
    if (type === VerifiedDocumentType.DNI) {
      const tipo = valorDe(lecturas["tipo_documento"]);
      const pais = valorDe(lecturas["pais_emisor"]);
      if ((tipo && tipo !== "ID") || (pais && pais !== "ARG")) {
        reasons.push(verificationReason("DOCUMENTO_NO_ES_ARGENTINO"));
      }
    }

    // En Argentina el número de licencia ES el número de DNI. Que no lo sea
    // significa, casi siempre, que las dos fotos son de documentos de personas
    // distintas — que es exactamente lo que hay que atrapar.
    const dni = fields["numero_documento"]?.value;
    const licencia = fields["numero_licencia"]?.value;
    if (dni && licencia && dni !== licencia) {
      reasons.push(verificationReason("LICENCIA_NO_ES_DEL_TITULAR"));
    }

    // El CUIL lleva el DNI adentro: 20-49380010-9 contiene 49380010. Es una
    // comprobación gratis que la API ya validó por su dígito verificador, y
    // acá cierra el círculo contra el número de documento.
    const cuil = fields["cuil"]?.value;
    if (cuil && dni) {
      const delMedio = cuil.split("-")[1]?.replace(/^0+/, "");
      if (delMedio && delMedio !== dni) {
        reasons.push(verificationReason("CUIL_NO_CORRESPONDE_AL_DNI"));
      }
    }

    return reasons;
  }

  /** Vencimientos, clase y período de principiante. */
  private controlesDeVigencia(
    type: VerifiedDocumentType,
    facts: ExtractedFacts,
  ): VerificationReason[] {
    const reasons: VerificationReason[] = [];
    const hoy = comienzoDelDia(new Date());

    if (facts.expiresAt && facts.expiresAt < hoy) {
      // Un documento vencido no se aprueba: lo que prueba la identidad es un
      // documento vigente. Para el DNI se avisa aparte porque el usuario puede
      // ya estar verificado y lo que corresponde es pedirle que lo renueve.
      reasons.push(
        verificationReason(
          type === VerifiedDocumentType.LICENSE
            ? "DOCUMENTO_VENCIDO"
            : "DNI_VENCIDO",
          { date: isoCorto(facts.expiresAt) },
        ),
      );
    }

    if (type === VerifiedDocumentType.LICENSE && facts.licenseClass) {
      if (!habilitaAuto(facts.licenseClass)) {
        reasons.push(
          verificationReason("LICENCIA_CLASE_NO_HABILITA", {
            detail: facts.licenseClass,
          }),
        );
      }
    }

    if (facts.licenseBeginnerUntil && facts.licenseBeginnerUntil >= hoy) {
      reasons.push(
        verificationReason("LICENCIA_PRINCIPIANTE", {
          date: isoCorto(facts.licenseBeginnerUntil),
        }),
      );
    }

    return reasons;
  }
}

/**
 * Motivos que se anotan pero no impiden aprobar el documento.
 *
 * La distinción es entre "este documento no es confiable" y "este documento es
 * tuyo pero no te habilita a manejar". Una licencia clase A es genuinamente tu
 * licencia: verificar tu identidad con ella está bien, y lo que corresponde es
 * aprobarla y después no dejarte alquilar un auto — con el motivo a la vista.
 * Mandarla a un admin sería hacerle perder el tiempo con un documento que está
 * perfecto.
 *
 * El vencido no está en esta lista a propósito: un documento vencido ya no
 * prueba identidad, así que ahí sí interviene una persona.
 */
const NO_IMPIDEN_APROBAR = new Set<string>([
  "LICENCIA_CLASE_NO_HABILITA",
  "LICENCIA_PRINCIPIANTE",
]);

/** Cada campo → qué dijo cada origen sobre él. */
type Lecturas = Record<string, Record<string, DocverifyField>>;

/**
 * Aplana las dos caras y todos sus orígenes en un mapa por campo.
 *
 * Se trabaja sobre `caras` y no sobre el `coincidencias` que ya trae la API
 * porque acá hace falta también la CONFIANZA de cada lectura, y ese resumen
 * solo trae los valores. La API compara; este backend además pondera.
 */
function recolectarLecturas(result: DocverifyResult): Lecturas {
  const lecturas: Lecturas = {};
  for (const [cara, sobre] of Object.entries(result.caras ?? {})) {
    for (const [origen, fuente] of Object.entries(sobre?.origenes ?? {})) {
      for (const [campo, dato] of Object.entries(fuente?.campos ?? {})) {
        if (!dato?.valor) continue;
        (lecturas[campo] ??= {})[`${cara}.${origen}`] = dato;
      }
    }
  }
  return lecturas;
}

/** El valor de un campo sin mirar quién lo dijo. Vacío si nadie lo leyó. */
function valorDe(
  porOrigen: Record<string, DocverifyField> | undefined,
): string {
  if (!porOrigen) return "";
  return Object.values(porOrigen)[0]?.valor ?? "";
}

/** Compara un campo entre orígenes y contra la cuenta. */
function evaluarCampo(
  campo: string,
  porOrigen: Record<string, DocverifyField>,
  user: User,
): FieldVerdict {
  const entradas = Object.entries(porOrigen);
  const distintos = [
    ...new Set(entradas.map(([, d]) => normalizarPara(campo, d.valor))),
  ];
  const agrees = distintos.length === 1;

  // Con desacuerdo gana el que el motor leyó con más confianza. No es para
  // dar por bueno el dato —el desacuerdo ya mandó esto a revisión manual— sino
  // para que el informe muestre algo razonable y no la primera lectura al azar.
  const ganador = entradas.reduce((mejor, actual) =>
    actual[1].confianza > mejor[1].confianza ? actual : mejor,
  );

  const campoCuenta =
    CAMPO_DE_LA_CUENTA[campo as keyof typeof CAMPO_DE_LA_CUENTA];
  const deLaCuenta = campoCuenta ? user[campoCuenta] : null;

  return {
    value: ganador[1].valor,
    sources: entradas.map(([nombre]) => nombre).sort(),
    values: [...new Set(entradas.map(([, d]) => d.valor))],
    agrees,
    corroborated: agrees && entradas.length > 1,
    matchesAccount:
      deLaCuenta == null
        ? null
        : mismoValor(campo, ganador[1].valor, deLaCuenta),
  };
}

/**
 * Si el valor leído y el de la cuenta son el mismo dato.
 *
 * `numero_licencia` se compara contra el DNI de la cuenta porque en Argentina
 * son el mismo número; el resto, contra su campo homónimo.
 */
function mismoValor(
  campo: string,
  leido: string,
  deLaCuenta: string | Date,
): boolean {
  if (deLaCuenta instanceof Date) {
    return isoCorto(deLaCuenta) === leido.slice(0, 10);
  }
  return mismoTexto(campo, leido, deLaCuenta);
}

/**
 * Comparación de textos tolerante a lo que cambia sin cambiar el dato.
 *
 * Tildes, mayúsculas, espacios de más y —en los números— puntos y guiones. Un
 * DNI cargado como "49.380.010" y leído como "49380010" es el mismo número, y
 * tratarlos como distintos mandaría a revisión manual a media plataforma.
 *
 * El orden de las palabras SÍ importa: "TEJADA ARAGON" y "ARAGON TEJADA" son
 * apellidos distintos y no hay que darlos por iguales.
 */
function mismoTexto(campo: string, a: string, b: string): boolean {
  const leido = normalizarPara(campo, a);
  const cuenta = normalizarPara(campo, b);
  if (leido === cuenta) return true;

  /**
   * UNA letra de diferencia en el nombre o el apellido no alcanza para mandar
   * a alguien a revisión manual. El OCR confunde L con T y M con N sobre una
   * foto con reflejo: "EMITIANO" donde dice "EMILIANO" es un defecto de la
   * cámara, no una identidad distinta, y tratarlo como tal frena a una persona
   * real por algo que no hizo.
   *
   * Solo acá. Un dígito de diferencia en un DNI SÍ es otro documento, y una
   * fecha corrida un día es otra fecha: ahí no hay nada que perdonar.
   *
   * Lo que esto acepta de más, y es a sabiendas: dos nombres reales separados
   * por una letra —MARIA y MARIO— pasan como iguales. Es tolerable porque el
   * veredicto de este servicio nunca es RECHAZAR, así que lo peor que produce
   * es aprobar de más, y eso lo atrapan después el control antifraude del
   * número de documento y la revisión del administrador. Al revés —rechazar de
   * menos— no lo atrapa nadie.
   *
   * Y no toca la comparación ENTRE orígenes, que se hace aparte con
   * `normalizarPara` (ver `evaluarCampo`): que lo impreso y el código de
   * barras digan cosas distintas sigue siendo la firma del fraude, y ahí la
   * exigencia no se afloja ni una letra.
   */
  if (!TOLERAN_UN_ERROR_DE_LECTURA.has(campo)) return false;

  return distanciaAcotada(leido, cuenta, 1) <= 1;
}

/** Los campos donde una sola letra de diferencia se perdona. */
const TOLERAN_UN_ERROR_DE_LECTURA = new Set(["nombre", "apellido"]);

/**
 * Cuántas letras hay que cambiar, agregar o sacar para convertir un texto en
 * el otro (distancia de Levenshtein), pero cortando apenas pasa `tope`.
 *
 * El corte no es una optimización: es lo que hace que la función responda la
 * única pregunta que interesa —"¿están a una letra?"— en vez de calcular cuán
 * distintos son dos nombres que no tienen nada que ver.
 */
function distanciaAcotada(a: string, b: string, tope: number): number {
  if (Math.abs(a.length - b.length) > tope) return tope + 1;

  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    let mejorDeLaFila = i;

    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      actual[j] = Math.min(
        anterior[j] + 1, // sacar una letra
        actual[j - 1] + 1, // agregar una letra
        anterior[j - 1] + costo, // cambiarla
      );
      mejorDeLaFila = Math.min(mejorDeLaFila, actual[j]);
    }

    // Ninguna fila posterior puede mejorar el mínimo de ésta, así que si acá
    // ya se pasó del tope, se pasó y punto.
    if (mejorDeLaFila > tope) return tope + 1;
    anterior = actual;
  }

  return anterior[b.length];
}

function normalizarPara(campo: string, valor: string): string {
  const base = (valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();

  if (campo === "numero_documento" || campo === "numero_licencia") {
    return base.replace(/\D/g, "").replace(/^0+/, "");
  }
  if (campo === "cuil") {
    return base.replace(/\D/g, "");
  }
  if (campo === "fecha_nacimiento" || campo === "fecha_vencimiento") {
    return base.slice(0, 10);
  }
  return base
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lo que el documento aportó y el perfil no tenía. */
function extraerHechos(
  type: VerifiedDocumentType,
  lecturas: Lecturas,
  fields: Record<string, FieldVerdict>,
): ExtractedFacts {
  const clase = valorDe(lecturas["clase"]);
  const principiante = valorDe(lecturas["es_principiante"]) === "true";
  const finPrincipiante = valorDe(lecturas["fin_principiante"]);

  return {
    expiresAt: aFecha(valorDe(lecturas["fecha_vencimiento"])),
    licenseClass: type === VerifiedDocumentType.LICENSE && clase ? clase : null,
    licenseIssuedAt:
      type === VerifiedDocumentType.LICENSE
        ? aFecha(valorDe(lecturas["fecha_otorgamiento"]))
        : null,
    // Sin fecha de fin no se puede saber si el período sigue corriendo, así
    // que una licencia marcada como principiante pero sin fecha no bloquea
    // nada: lo que no se sabe no se puede aplicar.
    licenseBeginnerUntil: principiante ? aFecha(finPrincipiante) : null,
    documentNumber: fields["numero_documento"]?.value ?? null,
  };
}

/**
 * "2026-10-28" → Date, en UTC a mediodía.
 *
 * A MEDIODÍA Y NO A MEDIANOCHE, que es lo que hace `new Date("2026-10-28")`.
 * Una fecha sin hora guardada a medianoche UTC, leída en Argentina (UTC-3),
 * cae el día anterior a las 21:00: una licencia que vence el 28 figuraría
 * venciendo el 27. El mediodía deja doce horas de margen para cada lado, que
 * cubre cualquier zona horaria del mundo.
 */
function aFecha(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? "")) return null;
  const fecha = new Date(`${iso}T12:00:00.000Z`);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/** Date → "2026-10-28", en UTC (que es como se guardó, ver aFecha). */
function isoCorto(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

function comienzoDelDia(fecha: Date): Date {
  return new Date(
    Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()),
  );
}

/**
 * Si esta clase de licencia habilita a conducir un auto particular.
 *
 * Exportada porque la usa también el control de habilitación para alquilar:
 * tiene que ser LA MISMA función en los dos lados, o se puede aprobar una
 * licencia que después no habilita nada (o al revés) sin que nadie lo note.
 */
export function habilitaAuto(clase: string | null | undefined): boolean {
  if (!clase) return false;
  const letra = clase.trim().toUpperCase().charAt(0);
  return CLASES_QUE_HABILITAN_AUTO.has(letra);
}
