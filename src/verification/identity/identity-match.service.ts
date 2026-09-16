import { Injectable } from "@nestjs/common";
import { User, VerifiedDocumentType } from "@prisma/client";
import { DocverifyField, DocverifyResult } from "./docverify.client";
import { modoDemo } from "../../common/demo-mode";
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
 *    impreso, adentro del código (PDF417 o QR) y adentro de la MRZ. Los tres
 *    tienen que coincidir. Cuando alguien altera una tarjeta cambia lo
 *    impreso, que es lo visible, y el código sigue diciendo el dato original:
 *    esa contradicción es la firma del fraude, y compararlos es lo único que
 *    la muestra.
 *
 * 2. ¿COINCIDE CON LA CUENTA? De nada sirve un documento perfectamente
 *    coherente si es de otra persona. Nombre, apellido, DNI, nacimiento y CUIL
 *    se comparan contra lo que el usuario cargó en su perfil.
 *
 * 3. ¿HABILITA? Una licencia legítima y del titular igual no sirve si venció o
 *    si es de moto. Eso no invalida el documento —se aprueba igual, porque ES
 *    su licencia— pero queda anotado y es lo que después impide alquilar.
 *
 * ── Lo que NO se cruza, y por qué ────────────────────────────────────────────
 *
 * · EL DOMICILIO. No entra en la comparación y no es un olvido. El de la
 *   cuenta lo escribe una persona a mano ("Av. Santa Fe 1234, 3º B") y el del
 *   documento lo devuelve un OCR sobre letra chica, con la provincia
 *   abreviada, sin el piso, con la calle cortada. Los dos describen el mismo
 *   lugar y casi nunca son el mismo texto: cruzarlos producía un desacuerdo
 *   casi siempre, sobre documentos correctos, sin detectar ningún fraude a
 *   cambio. Un domicilio tampoco prueba identidad — las personas se mudan.
 *
 * · EL CÓDIGO DEL DORSO DE LA LICENCIA (su PDF417 y su código de barras
 *   lineal). Ver ORIGENES_IGNORADOS.
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
 * "TEJADA ARAGON" y "Tejada Aragón" son la misma persona. "49.380.010" y
 * "49380010" son el mismo número. "28/10/2026" y "2026-10-28" son el mismo
 * día. Cada origen entrega el dato en el formato que le sale —el OCR copia lo
 * impreso con sus puntos, el código lo trae pelado, la MRZ lo trae en su
 * propio formato— y comparar los textos crudos produciría un desacuerdo por
 * cada guión, punto o coma de diferencia: una avalancha de revisiones
 * manuales sobre documentos perfectos.
 *
 * Así que NADA se compara crudo. Todo pasa por `mismoDato`, que lleva cada
 * campo a su forma canónica según lo que ese campo ES —un número, una fecha,
 * un nombre— y no según cómo vino escrito. El valor original queda guardado
 * igual, para poder auditar después qué se comparó contra qué.
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
 *
 * El domicilio tampoco está, y ese sí es a propósito: ver la nota de la
 * cabecera sobre lo que no se cruza.
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
 * ⚠️ TEMPORAL — MODO DEMO. Ver src/common/demo-mode.ts.
 *
 * Probando queda solo lo que dice de QUIÉN es el documento. El vencimiento se
 * cae porque en este modo no se mira, y la fecha de nacimiento porque es el
 * campo que peor sale en una foto de prueba y bloquear por él no demuestra
 * nada: si se llega a leer, igual se cruza contra la cuenta.
 */
const IMPRESCINDIBLES_DEMO: Record<VerifiedDocumentType, string[]> = {
  DNI: ["numero_documento", "apellido", "nombre"],
  LICENSE: ["apellido", "nombre"],
};

function imprescindibles(type: VerifiedDocumentType): string[] {
  return modoDemo() ? IMPRESCINDIBLES_DEMO[type] : IMPRESCINDIBLES[type];
}

/**
 * LOS ORÍGENES QUE NO SE MIRAN, POR DOCUMENTO.
 *
 * EL CÓDIGO DEL DORSO DE LA LICENCIA NO SE USA, cualquiera sea. La tarjeta
 * trae ahí un PDF417 —o un QR, en las emisiones nuevas— y una tira lineal
 * pegada al borde, y ninguno se lee de forma confiable en una foto de
 * teléfono: el contenido del código cambió de formato entre emisiones y entre
 * jurisdicciones, así que cuando decodifica suele entregar campos a medias, y
 * el lineal no contiene el número de licencia (en la tarjeta con la que se
 * probó dice nueve dígitos que no son el DNI de nadie).
 *
 * El resultado era el peor posible: un dato leído MAL contradecía al dato
 * leído BIEN del frente, y esa contradicción —que es la señal de fraude que
 * el cruce entre orígenes existe para detectar— mandaba a revisión manual
 * licencias auténticas, una y otra vez. Un origen que se equivoca seguido no
 * corrobora nada: solo ensucia a los que sí leen.
 *
 * La licencia se cruza entonces contra el DNI y contra la cuenta, que es
 * donde el dato viene de una fuente independiente de verdad. La API los sigue
 * leyendo y devolviendo —el contenido crudo va en `detalle`—, así que no se
 * pierde nada para diagnosticar ni para el HTML de prueba: lo que se decide
 * acá es solo qué se cruza.
 *
 * El día que alguna emisión traiga un código de dorso que lea limpio, sacarlo
 * de esta lista es cambiar una palabra en el regex de abajo.
 */
const ORIGENES_IGNORADOS: Partial<Record<VerifiedDocumentType, RegExp>> = {
  [VerifiedDocumentType.LICENSE]: /^dorso\.(pdf417|qr|codigo_1d)$/,
};

/**
 * Los orígenes que son un CÓDIGO LEGIBLE POR MÁQUINA, o sea lo que una
 * tarjeta adulterada no puede reescribir.
 *
 * Son dos y son intercambiables: el DNI argentino lleva un PDF417, pero las
 * emisiones nuevas traen un QR en su lugar. Da igual cuál de los dos sea —lo
 * que importa es que haya ALGUNO, porque es la única parte del documento que
 * no se puede retocar con un editor de imágenes.
 */
const ORIGENES_DE_CODIGO = new Set(["pdf417", "qr"]);

/**
 * Qué documentos tienen que traer sí o sí uno de esos códigos.
 *
 * El DNI sí: su PDF417 (o su QR, en las emisiones nuevas) es lo que sostiene
 * todo el cruce entre orígenes. Sin él lo único que hay es el texto impreso,
 * que es exactamente lo que altera quien falsifica una tarjeta.
 *
 * La licencia no, y es la contracara de ORIGENES_IGNORADOS: sus códigos no se
 * leen de forma confiable, así que exigirlos dejaría todas las licencias en
 * revisión manual. Se cruza contra el DNI ya verificado y contra la cuenta.
 */
const EXIGEN_CODIGO = new Set<VerifiedDocumentType>([VerifiedDocumentType.DNI]);

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
    const lecturas = recolectarLecturas(result, type);
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
    for (const campo of imprescindibles(type)) {
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

    return {
      // Cualquier motivo manda a revisión manual. No hay motivos "leves": si
      // algo no cerró, lo mira una persona. Lo que sí hay son motivos que no
      // impiden aprobar —los de habilitación— y esos se filtran abajo.
      verdict: reasons.some((r) => !NO_IMPIDEN_APROBAR.has(r.code))
        ? "MANUAL_REVIEW"
        : "APPROVE",
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

    // EL CÓDIGO TIENE QUE ESTAR: PDF417 o QR, cualquiera de los dos.
    //
    // Es lo único del documento que no se puede retocar, así que sin ninguno
    // de los dos el cruce entre orígenes se queda comparando el texto impreso
    // contra sí mismo — que es precisamente lo que una tarjeta adulterada
    // pasa sin despeinarse. No rechaza: lo mira un admin.
    // ⚠️ TEMPORAL: en modo demo no se exige (ver src/common/demo-mode.ts).
    if (!modoDemo() && EXIGEN_CODIGO.has(type) && !hayCodigo(lecturas)) {
      reasons.push(verificationReason("CODIGO_NO_LEIDO"));
    }

    // La MRZ tiene que decir que esto es un documento de identidad argentino.
    // Se controla solo si se pudo leer: que no haya MRZ es un problema de
    // legibilidad, y ese ya lo reportó IMPRESCINDIBLES.
    if (type === VerifiedDocumentType.DNI) {
      const tipo = valorDe(lecturas["tipo_documento"]).trim().toUpperCase();
      const pais = valorDe(lecturas["pais_emisor"]).trim().toUpperCase();
      if ((tipo && tipo !== "ID") || (pais && pais !== "ARG")) {
        reasons.push(verificationReason("DOCUMENTO_NO_ES_ARGENTINO"));
      }
    }

    // En Argentina el número de licencia ES el número de DNI. Que no lo sea
    // significa, casi siempre, que las dos fotos son de documentos de personas
    // distintas — que es exactamente lo que hay que atrapar.
    //
    // Se comparan NORMALIZADOS: el frente de la licencia suele traer el número
    // pelado y el DNI impreso viene con puntos, así que compararlos crudos
    // señalaba como "de otra persona" a dos lecturas del mismo número.
    const dni = normalizarPara(
      "numero_documento",
      fields["numero_documento"]?.value ?? "",
    );
    const licencia = normalizarPara(
      "numero_licencia",
      fields["numero_licencia"]?.value ?? "",
    );
    if (dni && licencia && dni !== licencia) {
      reasons.push(verificationReason("LICENCIA_NO_ES_DEL_TITULAR"));
    }

    // El CUIL lleva el DNI adentro: 20-49380010-9 contiene 49380010. Es una
    // comprobación gratis que la API ya validó por su dígito verificador, y
    // acá cierra el círculo contra el número de documento.
    //
    // Se saca de los DÍGITOS y no cortando por los guiones: el mismo CUIL
    // llega con guiones desde el OCR y pelado desde un código, y `split("-")`
    // no encontraba nada en el segundo caso.
    const cuil = dniDelCuil(fields["cuil"]?.value ?? "");
    if (cuil && dni && cuil !== dni) {
      reasons.push(verificationReason("CUIL_NO_CORRESPONDE_AL_DNI"));
    }

    return reasons;
  }

  /** Vencimientos, clase y período de principiante. */
  private controlesDeVigencia(
    type: VerifiedDocumentType,
    facts: ExtractedFacts,
  ): VerificationReason[] {
    const reasons: VerificationReason[] = [];
    // ⚠️ TEMPORAL — MODO DEMO: probando no se mira ni el vencimiento, ni la
    // clase, ni el período de principiante. Lo único que tiene que cerrar es
    // que el documento sea de esta persona. Ver src/common/demo-mode.ts.
    if (modoDemo()) return reasons;

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
 *
 * Los orígenes que este documento no mira (ORIGENES_IGNORADOS) se descartan
 * ACÁ y no más adelante: filtrarlos en la entrada es lo que garantiza que no
 * puedan influir en nada —ni en el desacuerdo entre orígenes, ni en el valor
 * ganador, ni en los hechos extraídos— en vez de tener que acordarse de
 * excluirlos en cada control por separado.
 */
function recolectarLecturas(
  result: DocverifyResult,
  type: VerifiedDocumentType,
): Lecturas {
  const ignorados = ORIGENES_IGNORADOS[type];
  const lecturas: Lecturas = {};
  for (const [cara, sobre] of Object.entries(result.caras ?? {})) {
    for (const [origen, fuente] of Object.entries(sobre?.origenes ?? {})) {
      const ruta = `${cara}.${origen}`;
      if (ignorados?.test(ruta)) continue;
      for (const [campo, dato] of Object.entries(fuente?.campos ?? {})) {
        if (!dato?.valor) continue;
        (lecturas[campo] ??= {})[ruta] = dato;
      }
    }
  }
  return lecturas;
}

/**
 * Si alguno de los códigos legibles por máquina aportó algún dato.
 *
 * Mira que haya aportado un CAMPO y no que el origen exista: la API devuelve
 * siempre los cuatro orígenes posibles, con `disponible: false` cuando esa
 * cara no tiene ese código. Un origen presente pero sin nada leído es
 * exactamente el caso que hay que atrapar.
 */
function hayCodigo(lecturas: Lecturas): boolean {
  return Object.values(lecturas).some((porOrigen) =>
    Object.keys(porOrigen).some((ruta) =>
      ORIGENES_DE_CODIGO.has(ruta.split(".")[1] ?? ""),
    ),
  );
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

  // Con desacuerdo gana el que el motor leyó con más confianza. No es para
  // dar por bueno el dato —el desacuerdo ya mandó esto a revisión manual— sino
  // para que el informe muestre algo razonable y no la primera lectura al azar.
  const ganador = entradas.reduce((mejor, actual) =>
    actual[1].confianza > mejor[1].confianza ? actual : mejor,
  );

  // El acuerdo se mide contra el ganador y con `mismoDato`, no comparando
  // formas canónicas en un Set: los nombres tienen su propia regla (un
  // segundo nombre que un origen trae y otro no sigue siendo la misma
  // persona) y esa regla no se puede expresar como "normalizar y comparar".
  const agrees = entradas.every(([, dato]) =>
    mismoDato(campo, dato.valor, ganador[1].valor),
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
    return mismoDato(campo, leido, isoCorto(deLaCuenta));
  }
  return mismoDato(campo, leido, deLaCuenta);
}

/**
 * SI DOS TEXTOS SON EL MISMO DATO, venga cada uno en el formato que venga.
 *
 * Es el único punto por el que pasa toda comparación de este archivo, y la
 * razón de que exista uno solo es que un cruce que se olvide de normalizar no
 * falla: pasa a rechazar documentos buenos, en silencio, hasta que alguien se
 * queja.
 *
 * Los nombres tienen su propia regla; todo lo demás se lleva a su forma
 * canónica y se compara letra por letra.
 */
function mismoDato(campo: string, a: string, b: string): boolean {
  if (ES_NOMBRE.has(campo)) return mismoNombre(a, b);
  return normalizarPara(campo, a) === normalizarPara(campo, b);
}

/** Los campos que son un nombre de persona y se comparan como tal. */
const ES_NOMBRE = new Set(["apellido", "nombre"]);

/**
 * Dos nombres (o dos apellidos) que se refieren a la misma persona.
 *
 * Tildes, mayúsculas, comas y espacios de más no cuentan: "Tejada Aragón" y
 * "TEJADA  ARAGON" son lo mismo, y "PEREZ, JUAN" —como lo escribe una MRZ—
 * también.
 *
 * Y ADEMÁS: uno puede traer partes que el otro no. El formulario de la cuenta
 * suele tener un solo nombre de pila y el documento los dos ("EMILIANO" contra
 * "EMILIANO JOSE"); la MRZ trunca los apellidos largos; algunos códigos traen
 * solo el primer apellido. Son diferencias de FORMATO DEL ORIGEN, no personas
 * distintas, así que alcanza con que las partes del más corto aparezcan EN EL
 * MISMO ORDEN dentro del más largo.
 *
 * El orden importa y por eso es una subsecuencia y no un subconjunto:
 * "TEJADA ARAGON" y "ARAGON TEJADA" son apellidos distintos —uno es hijo de
 * los otros dos al revés— y darlos por iguales sería aprobar el documento de
 * otra persona de la misma familia.
 */
function mismoNombre(a: string, b: string): boolean {
  const unos = partesDeNombre(a);
  const otros = partesDeNombre(b);
  if (unos.length === 0 || otros.length === 0) return false;
  if (unos.length === otros.length) {
    return unos.every((parte, i) => parte === otros[i]);
  }
  const [cortas, largas] =
    unos.length < otros.length ? [unos, otros] : [otros, unos];
  return esSubsecuencia(cortas, largas);
}

/** Las palabras de un nombre, sin tildes, signos ni mayúsculas/minúsculas. */
function partesDeNombre(valor: string): string[] {
  return textoBase(valor)
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Si todas las partes de `cortas` aparecen, en orden, dentro de `largas`. */
function esSubsecuencia(cortas: string[], largas: string[]): boolean {
  let i = 0;
  for (const parte of largas) {
    if (parte === cortas[i]) i += 1;
    if (i === cortas.length) return true;
  }
  return false;
}

/**
 * Un texto llevado a lo que no cambia según quién lo escribió: sin tildes, en
 * mayúsculas y sin espacios de sobra.
 */
function textoBase(valor: string): string {
  return (valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
}

/**
 * LA FORMA CANÓNICA DE UN CAMPO: lo que ese dato ES, sin el formato con el que
 * cada origen lo escribe.
 *
 * Cada familia de campo se reduce a lo que la identifica:
 *
 *   · los números de documento y de licencia → sus dígitos, sin los puntos que
 *     trae el impreso y sin los ceros con los que un código los rellena;
 *   · el CUIL → sus once dígitos, con o sin guiones;
 *   · las fechas → ISO, vengan como "28/10/2026", "28-10-26" o ya en ISO;
 *   · el sexo → una letra, aunque el OCR haya leído la palabra entera;
 *   · la clase de licencia → letra y subdivisión, con el punto o sin él;
 *   · cualquier otro texto → sin tildes, sin signos y sin espacios de más.
 */
function normalizarPara(campo: string, valor: string): string {
  const base = textoBase(valor);

  if (campo === "numero_documento" || campo === "numero_licencia") {
    return soloDigitos(base).replace(/^0+/, "");
  }
  if (campo === "cuil") {
    return soloDigitos(base);
  }
  if (ES_FECHA.has(campo)) {
    return aIso(base);
  }
  if (campo === "sexo") {
    return normalizarSexo(base);
  }
  if (campo === "clase") {
    return normalizarClase(base);
  }
  return base
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ES_FECHA = new Set([
  "fecha_nacimiento",
  "fecha_vencimiento",
  "fecha_otorgamiento",
  "fin_principiante",
]);

function soloDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

/**
 * Una fecha en cualquiera de los formatos que llegan → "YYYY-MM-DD".
 *
 * La API normaliza a ISO lo que puede, pero no todo llega por ahí: el valor
 * de la cuenta, un campo que un origen nuevo devuelva crudo, un formato de
 * código que todavía no se parsea. Que la comparación aguante las tres formas
 * habituales cuesta diez líneas y evita el peor tipo de falso desacuerdo: el
 * que dice que la fecha de nacimiento del documento no es la de la cuenta
 * cuando es exactamente el mismo día escrito al revés.
 *
 * Un año de dos dígitos se resuelve por cercanía: 26 es 2026 y 99 es 1999. El
 * corte está en 50 porque de este lado quedan los vencimientos y del otro las
 * fechas de nacimiento, que es como se reparten de verdad.
 */
function aIso(valor: string): string {
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(valor);
  if (iso) return armarIso(iso[1], iso[2], iso[3]);

  const dma = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(valor);
  if (dma) return armarIso(anioCompleto(dma[3]), dma[2], dma[1]);

  // "28102026" / "20261028": sin separadores, como los devuelven algunos
  // códigos. Se distingue por dónde queda el año.
  const pegado = /^(\d{8})$/.exec(valor);
  if (pegado) {
    const d = pegado[1];
    return d.slice(0, 2) > "12"
      ? armarIso(d.slice(4), d.slice(2, 4), d.slice(0, 2))
      : armarIso(d.slice(0, 4), d.slice(4, 6), d.slice(6, 8));
  }

  return valor.slice(0, 10);
}

function armarIso(anio: string, mes: string, dia: string): string {
  return `${anio.padStart(4, "0")}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`;
}

function anioCompleto(anio: string): string {
  if (anio.length === 4) return anio;
  return Number(anio) < 50 ? `20${anio}` : `19${anio}`;
}

/** "MASCULINO", "M", "Masc." → "M". Lo que no se reconoce vuelve tal cual. */
function normalizarSexo(base: string): string {
  const limpio = base.replace(/[^A-Z]/g, "");
  if (limpio.startsWith("MASC") || limpio === "M") return "M";
  if (limpio.startsWith("FEM") || limpio === "F") return "F";
  if (limpio === "X") return "X";
  return limpio;
}

/** "B.1", "B1", "b 1" → "B1". El punto es decoración del impreso. */
function normalizarClase(base: string): string {
  return base.replace(/[^A-Z0-9]/g, "");
}

/**
 * El número de DNI que lleva un CUIL adentro, o vacío si no es un CUIL.
 *
 * Los once dígitos son prefijo (2) + DNI (8) + verificador (1), así que el
 * documento son los del medio, sin los ceros con los que se rellena un DNI de
 * siete cifras. Se trabaja sobre los dígitos y no sobre los guiones porque el
 * mismo CUIL llega de las dos formas según el origen que lo haya leído.
 */
function dniDelCuil(cuil: string): string {
  const digitos = soloDigitos(cuil);
  if (digitos.length !== 11) return "";
  return digitos.slice(2, 10).replace(/^0+/, "");
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
 *
 * Acepta también los formatos con barras: la fecha entra por `aIso` antes de
 * mirarse, así que un origen que devuelva "28/10/2026" ya no se pierde.
 */
function aFecha(valor: string): Date | null {
  const iso = aIso(textoBase(valor));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const fecha = new Date(`${iso}T12:00:00.000Z`);
  if (Number.isNaN(fecha.getTime())) return null;
  // `new Date("2026-02-31")` no falla: rueda al 3 de marzo. Comparar la vuelta
  // contra lo que entró es lo que descarta una fecha que no existe.
  return fecha.toISOString().slice(0, 10) === iso ? fecha : null;
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
