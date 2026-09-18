import { Injectable } from "@nestjs/common";
import { User, VerifiedDocumentType } from "@prisma/client";
import { DocverifyField, DocverifyResult } from "./docverify.client";
import {
  DocumentKind,
  DocumentSlot,
  slotForFace,
  slotsOf,
} from "./document-slots";
import {
  fieldLabel,
  NO_IMPIDEN_APROBAR,
  VerificationReason,
  verificationReason,
} from "../errors/verification-reasons";

/**
 * EL CRUCE: ¿ESTE DOCUMENTO ES REAL, Y DICE LO QUE SU DUEÑO DIJO QUE DECÍA?
 *
 * ── Qué cambió, y por qué importa ────────────────────────────────────────────
 * Antes la lectura automática SACABA datos del documento y los guardaba: el
 * vencimiento de la licencia, la clase, la fecha de otorgamiento. Eso tenía un
 * problema que no se ve hasta que pasa: un OCR que lee mal un "2029" como
 * "2019" dejaba la cuenta verificada y a la persona sin poder reservar, con un
 * cartel que decía "tu licencia está vencida" sobre una licencia vigente. Y no
 * había nada que la persona pudiera hacer, porque el dato equivocado no lo
 * había cargado ella.
 *
 * Ahora es al revés: TODOS los datos los declara la persona, leyéndolos de su
 * propio documento, y la lectura automática existe para una sola cosa —decir si
 * la foto dice lo mismo—. Ningún valor leído se guarda. Si coinciden, el
 * documento se aprueba y lo declarado pasa a ser la verdad de la cuenta; si no
 * coinciden, se dice exactamente qué dato y en qué foto, y la persona corrige
 * o saca la foto de nuevo.
 *
 * Que la máquina se equivoque ahora cuesta un reenvío, no una cuenta trabada.
 *
 * ── Las cuatro preguntas, en orden ───────────────────────────────────────────
 *
 * 1. ¿SE PUDO LEER? Una cara de la que no salió nada es una foto para repetir,
 *    y se dice cuál. No es un documento fallado por el contenido: es una foto.
 *
 * 2. ¿EL DOCUMENTO DICE LO MISMO EN TODAS PARTES? Un DNI trae el apellido
 *    impreso, adentro del PDF417 y adentro de la MRZ. Los tres tienen que
 *    coincidir. Cuando alguien altera una tarjeta cambia lo impreso, que es lo
 *    visible, y el código sigue diciendo el dato original: esa contradicción es
 *    la firma del fraude, y compararlos es lo único que la muestra.
 *
 * 3. ¿COINCIDE CON LA CUENTA? Nombre, apellido, DNI, nacimiento y CUIL, contra
 *    lo que la persona cargó en su perfil.
 *
 * 4. ¿COINCIDE CON LO QUE DECLARÓ DE ESTE DOCUMENTO? Vencimiento y, en la
 *    licencia, otorgamiento, clase y período de principiante.
 *
 * ── Qué pasa cuando algo no cierra ───────────────────────────────────────────
 * El veredicto es APPROVE o FAIL, y un FAIL no es el final del camino: la
 * persona puede mandar fotos nuevas (y ahí se borran las viejas) o pedir que un
 * administrador mire estas mismas. Las fotos NO se borran al fallar, porque son
 * justamente lo que el admin necesita mirar; lo que no se puede es volver a
 * analizarlas, que ya tienen veredicto.
 *
 * Un documento VENCIDO se aprueba igual. Es auténtico y es de quien dice ser:
 * negarle la verificación lo dejaría sin cuenta y sin poder manejar, cuando el
 * problema es uno solo. El vencimiento queda anotado y lo aplica la capa de
 * habilitación.
 *
 * ── Y la regla que gobierna la comparación: normalizar antes ─────────────────
 * "TEJADA ARAGON" y "Tejada Aragón" son la misma persona. Comparar los textos
 * crudos produciría un desacuerdo por cada tilde y por cada espacio de más. Se
 * compara normalizado (ver `mismoTexto`).
 *
 * ── Lo que este archivo NO devuelve ──────────────────────────────────────────
 * Ningún valor leído de la foto. El informe dice si coincidió, cuántos orígenes
 * lo confirmaron y sobre qué foto, y nada más. Los valores viven un instante en
 * memoria durante la comparación y no se escriben en ninguna parte: ya los
 * tenemos declarados, y guardar además la versión que sacó una máquina que
 * puede equivocarse es guardar un dato peor por las dudas.
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

/**
 * Qué campo del perfil contrasta cada dato del documento.
 *
 * `sexo` no está y no es un olvido: la cuenta no lo guarda. Se cruza igual
 * ENTRE orígenes —si el texto impreso dice F y el código dice M, la tarjeta
 * está alterada— pero no hay contra qué compararlo del lado de la cuenta.
 */
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
 * Es el juego mínimo con el que la aprobación significa algo: sin el apellido
 * leído, "el documento coincide" no quiere decir nada.
 */
const IMPRESCINDIBLES: Record<VerifiedDocumentType, string[]> = {
  DNI: ["numero_documento", "apellido", "nombre", "fecha_nacimiento"],
  LICENSE: ["apellido", "nombre", "fecha_vencimiento"],
};

/**
 * En qué cara se espera encontrar cada dato. Es lo que permite decir "sacá de
 * nuevo la foto del dorso" cuando falta un dato que solo vive en el dorso, en
 * vez de mandar a repetir las dos fotos.
 *
 * El DNI argentino trae los datos personales impresos en el frente y repetidos
 * en el PDF417 y la MRZ del dorso; la licencia trae todo en el frente y el
 * código en el dorso. Cuando un dato puede estar en las dos, se nombran las
 * dos: repetir cualquiera de ellas puede arreglarlo.
 */
const CARA_ESPERADA: Record<VerifiedDocumentType, Record<string, string[]>> = {
  DNI: {
    numero_documento: ["frente", "dorso"],
    apellido: ["frente", "dorso"],
    nombre: ["frente", "dorso"],
    fecha_nacimiento: ["frente", "dorso"],
    fecha_vencimiento: ["frente"],
    sexo: ["frente", "dorso"],
    cuil: ["dorso"],
    tipo_documento: ["dorso"],
    pais_emisor: ["dorso"],
  },
  LICENSE: {
    numero_licencia: ["frente", "dorso"],
    apellido: ["frente", "dorso"],
    nombre: ["frente", "dorso"],
    fecha_nacimiento: ["frente", "dorso"],
    fecha_vencimiento: ["frente"],
    fecha_otorgamiento: ["frente"],
    clase: ["frente"],
    es_principiante: ["frente"],
    fin_principiante: ["frente"],
  },
};

/**
 * Las clases de licencia argentinas que habilitan a conducir un auto
 * particular.
 *
 * B es la de auto. C (camiones), D (transporte de pasajeros) y E (con
 * acoplado) son profesionales y, según el régimen nacional, para obtenerlas
 * hay que tener ya la B: quien tiene una de esas puede manejar un auto. A es
 * de moto y por sí sola NO habilita.
 *
 * Se compara por la LETRA inicial porque la clase viene subdividida ("B.1",
 * "B.2", "C.3") y las subdivisiones no cambian si se puede manejar un auto.
 */
const CLASES_QUE_HABILITAN_AUTO = new Set(["B", "C", "D", "E"]);

/**
 * LO QUE LA PERSONA DECLARÓ SOBRE UN DOCUMENTO.
 *
 * Es el único origen de estos datos. Lo carga en el formulario leyéndolo de su
 * propio documento, y la lectura automática lo corrobora contra la foto.
 */
export interface DeclaredDocumentData {
  /** Cuándo vence el documento. Obligatorio en los dos. */
  expiresAt: Date;
  /** Solo licencia: desde cuándo la tiene. */
  issuedAt?: Date | null;
  /** Solo licencia: B.1, A2.2, C... */
  licenseClass?: string | null;
  /** Solo licencia: si todavía está en período de principiante. */
  isBeginner?: boolean;
  /** Solo licencia: hasta cuándo dura ese período. */
  beginnerUntil?: Date | null;
}

/**
 * Lo que se decidió sobre un campo. SIN EL VALOR LEÍDO: esto se guarda, y lo
 * que la foto decía no se guarda (ver la nota de la clase).
 */
export interface FieldCheck {
  /** Cuántos orígenes independientes lo leyeron. */
  sources: number;
  /** Si todos los que lo leyeron dijeron lo mismo. */
  agrees: boolean;
  /** Si más de un origen independiente lo confirmó. */
  corroborated: boolean;
  /**
   * Si coincide con lo que la persona declaró (en el perfil o en el
   * formulario del documento). `null` = no había contra qué comparar.
   */
  matches: boolean | null;
  /** En qué fotos apareció. */
  slots: DocumentSlot[];
}

export interface IdentityMatchReport {
  verdict: "APPROVE" | "FAIL";
  reasons: VerificationReason[];
  /** Qué fotos hay que volver a sacar. Las demás sirven. */
  retakeSlots: DocumentSlot[];
  checks: Record<string, FieldCheck>;
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
   * informe con verdict FAIL y el motivo adentro, no una excepción.
   */
  evaluate(
    type: VerifiedDocumentType,
    result: DocverifyResult,
    user: User,
    declared: DeclaredDocumentData,
  ): IdentityMatchReport {
    const kind: DocumentKind =
      type === VerifiedDocumentType.DNI ? "dni" : "license";
    const lecturas = recolectarLecturas(result, kind);
    const checks: Record<string, FieldCheck> = {};
    const reasons: VerificationReason[] = [];

    // ── 1: ¿se pudo leer cada cara? ──────────────────────────────────────
    reasons.push(...carasIlegibles(result, kind));

    // ── 2 y 3: coherencia interna y contra la cuenta ─────────────────────
    for (const campo of CAMPOS_DE_IDENTIDAD) {
      const porOrigen = lecturas[campo];
      if (!porOrigen || porOrigen.length === 0) continue;

      const { check, valor } = evaluarCampo(campo, porOrigen, user);
      checks[campo] = check;

      if (!check.agrees) {
        reasons.push(
          verificationReason("DATO_NO_COINCIDE_ENTRE_ORIGENES", {
            field: campo,
            label: fieldLabel(campo),
            slots: check.slots,
            sources: check.sources,
          }),
        );
      } else if (check.matches === false) {
        reasons.push(
          verificationReason("DATO_NO_COINCIDE_CON_LA_CUENTA", {
            field: campo,
            label: fieldLabel(campo),
            slots: check.slots,
          }),
        );
      }
      // `valor` se usa abajo para los controles estructurales y después se
      // pierde con el stack. No sale de esta función.
      void valor;
    }

    // Los campos que hacen falta para que aprobar signifique algo.
    for (const campo of IMPRESCINDIBLES[type]) {
      if (lecturas[campo]?.length) continue;
      reasons.push(
        verificationReason("DATO_ILEGIBLE", {
          field: campo,
          label: fieldLabel(campo),
          slots: slotsEsperados(type, kind, campo),
        }),
      );
    }

    reasons.push(...controlesEstructurales(type, kind, lecturas));

    // ── 4: lo declarado contra lo que dice la foto ───────────────────────
    reasons.push(
      ...this.cruzarDeclarado(type, kind, lecturas, declared, checks),
    );

    // ── Qué habilita este documento ──────────────────────────────────────
    reasons.push(...vigenciaDeLoDeclarado(type, declared));

    // Cualquier motivo que no sea de habilitación hace fallar el documento.
    // No hay motivos "leves": si algo no cerró, la persona tiene que hacer
    // algo. Los de habilitación no cuentan porque el documento está bien; lo
    // que no habilita es lo que el documento dice.
    const algoNoCerro = reasons.some((r) => !NO_IMPIDEN_APROBAR.has(r.code));

    return {
      verdict: algoNoCerro ? "FAIL" : "APPROVE",
      reasons,
      retakeSlots: fotosARepetir(reasons),
      checks,
      analysis: {
        version: result.version ?? "",
        ms: result.ms ?? 0,
        ok: Boolean(result.ok),
      },
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Lo que la persona cargó sobre ESTE documento, contra lo que dice la foto.
   *
   * Es la parte nueva del cruce y la que hace que ningún dato salga del OCR:
   * el vencimiento, la clase y el período de principiante los declara ella, y
   * acá se confirma que el documento dice lo mismo.
   *
   * Un dato declarado que la foto NO trae no falla. La foto puede no llegar a
   * mostrar la fecha de otorgamiento y el documento seguir siendo perfectamente
   * válido; tratar "no lo pude leer" como "no coincide" mandaría a corregir un
   * dato que está bien. Lo que sí falla es que la foto lo traiga y diga otra
   * cosa.
   */
  private cruzarDeclarado(
    type: VerifiedDocumentType,
    kind: DocumentKind,
    lecturas: Lecturas,
    declared: DeclaredDocumentData,
    checks: Record<string, FieldCheck>,
  ): VerificationReason[] {
    const reasons: VerificationReason[] = [];

    const comparar = (
      campo: string,
      esperado: string | null,
      iguales: (leido: string) => boolean,
    ) => {
      const porOrigen = lecturas[campo];
      if (!porOrigen?.length || esperado == null) return;

      const distintos = new Set(
        porOrigen.map((l) => normalizarPara(campo, l.dato.valor)),
      );
      const slots = [...new Set(porOrigen.map((l) => l.slot))];
      const coincide = porOrigen.some((l) => iguales(l.dato.valor));

      checks[campo] = {
        sources: porOrigen.length,
        agrees: distintos.size === 1,
        corroborated: distintos.size === 1 && porOrigen.length > 1,
        matches: coincide,
        slots,
      };

      if (!coincide) {
        reasons.push(
          verificationReason("DATO_NO_COINCIDE_CON_LO_DECLARADO", {
            field: campo,
            label: fieldLabel(campo),
            slots,
          }),
        );
      }
    };

    comparar(
      "fecha_vencimiento",
      isoCorto(declared.expiresAt),
      (leido) => leido.slice(0, 10) === isoCorto(declared.expiresAt),
    );

    if (type !== VerifiedDocumentType.LICENSE) return reasons;

    if (declared.issuedAt) {
      comparar(
        "fecha_otorgamiento",
        isoCorto(declared.issuedAt),
        (leido) => leido.slice(0, 10) === isoCorto(declared.issuedAt as Date),
      );
    }

    if (declared.licenseClass) {
      comparar("clase", declared.licenseClass, (leido) =>
        mismaClase(leido, declared.licenseClass as string),
      );
    }

    // El período de principiante se cruza solo cuando la licencia lo declara:
    // una licencia que no es de principiante no trae la marca, y su ausencia
    // no prueba nada.
    if (declared.isBeginner) {
      const marca = lecturas["es_principiante"];
      if (marca?.length && !marca.some((l) => esVerdadero(l.dato.valor))) {
        reasons.push(
          verificationReason("DATO_NO_COINCIDE_CON_LO_DECLARADO", {
            field: "es_principiante",
            label: fieldLabel("es_principiante"),
            slots: [...new Set(marca.map((l) => l.slot))],
          }),
        );
      }
    }

    void kind;
    return reasons;
  }
}

// ── Controles que miran el documento contra sí mismo ────────────────────────

/**
 * Los controles que no comparan un valor contra otro sino que miran si el
 * documento tiene sentido consigo mismo.
 */
function controlesEstructurales(
  type: VerifiedDocumentType,
  kind: DocumentKind,
  lecturas: Lecturas,
): VerificationReason[] {
  const reasons: VerificationReason[] = [];

  // La MRZ tiene que decir que esto es un documento de identidad argentino.
  // Se controla solo si se pudo leer: que no haya MRZ es un problema de
  // legibilidad, y ese ya lo reportó IMPRESCINDIBLES.
  if (type === VerifiedDocumentType.DNI) {
    const tipo = primerValor(lecturas["tipo_documento"]);
    const pais = primerValor(lecturas["pais_emisor"]);
    if ((tipo && tipo !== "ID") || (pais && pais !== "ARG")) {
      reasons.push(
        verificationReason("DOCUMENTO_NO_ES_ARGENTINO", {
          slots: slotsEsperados(type, kind, "tipo_documento"),
        }),
      );
    }
  }

  // En Argentina el número de licencia ES el número de DNI. Que no lo sea
  // significa, casi siempre, que las dos fotos son de documentos de personas
  // distintas — que es exactamente lo que hay que atrapar.
  const dni = primerValor(lecturas["numero_documento"]);
  const licencia = primerValor(lecturas["numero_licencia"]);
  if (
    dni &&
    licencia &&
    normalizarPara("numero_documento", dni) !==
      normalizarPara("numero_licencia", licencia)
  ) {
    reasons.push(
      verificationReason("LICENCIA_NO_ES_DEL_TITULAR", {
        slots: slotsOf(kind),
      }),
    );
  }

  // El CUIL lleva el DNI adentro: 20-49380010-9 contiene 49380010. Es una
  // comprobación gratis que la API ya validó por su dígito verificador, y acá
  // cierra el círculo contra el número de documento.
  const cuil = primerValor(lecturas["cuil"]);
  if (cuil && dni) {
    const soloDigitos = normalizarPara("cuil", cuil);
    const delMedio = soloDigitos.slice(2, -1).replace(/^0+/, "");
    if (delMedio && delMedio !== normalizarPara("numero_documento", dni)) {
      reasons.push(
        verificationReason("CUIL_NO_CORRESPONDE_AL_DNI", {
          slots: slotsEsperados(type, kind, "cuil"),
        }),
      );
    }
  }

  return reasons;
}

/**
 * Vencimiento, clase y período de principiante, SOBRE LO DECLARADO.
 *
 * Se evalúa lo que declaró la persona y no lo que leyó la máquina, por lo
 * mismo que todo lo demás: es el dato que va a quedar guardado y el que va a
 * decidir qué puede hacer. Ninguno de estos motivos impide aprobar.
 */
function vigenciaDeLoDeclarado(
  type: VerifiedDocumentType,
  declared: DeclaredDocumentData,
): VerificationReason[] {
  const reasons: VerificationReason[] = [];
  const hoy = comienzoDelDia(new Date());

  if (comienzoDelDia(declared.expiresAt) < hoy) {
    reasons.push(
      verificationReason(
        type === VerifiedDocumentType.LICENSE
          ? "LICENCIA_VENCIDA"
          : "DNI_VENCIDO",
        { date: isoCorto(declared.expiresAt) },
      ),
    );
  }

  if (type !== VerifiedDocumentType.LICENSE) return reasons;

  if (declared.licenseClass && !habilitaAuto(declared.licenseClass)) {
    reasons.push(
      verificationReason("LICENCIA_CLASE_NO_HABILITA", {
        detail: declared.licenseClass,
      }),
    );
  }

  if (declared.beginnerUntil && comienzoDelDia(declared.beginnerUntil) >= hoy) {
    reasons.push(
      verificationReason("LICENCIA_PRINCIPIANTE", {
        date: isoCorto(declared.beginnerUntil),
      }),
    );
  }

  return reasons;
}

/**
 * Las caras de las que no salió absolutamente nada.
 *
 * Es distinto de un dato ilegible: acá la foto entera no sirvió —está movida,
 * oscura, es de otra cosa— y lo único que se puede hacer es sacarla de nuevo.
 * Decirlo por cara y no por documento es lo que evita mandar a repetir las dos
 * fotos cuando el problema está en una.
 */
function carasIlegibles(
  result: DocverifyResult,
  kind: DocumentKind,
): VerificationReason[] {
  const reasons: VerificationReason[] = [];
  for (const [cara, sobre] of Object.entries(result.caras ?? {})) {
    const slot = slotForFace(kind, cara);
    if (!slot) continue;

    const leyoAlgo = Object.values(sobre?.origenes ?? {}).some((fuente) =>
      Object.values(fuente?.campos ?? {}).some((dato) => dato?.valor),
    );
    if (!leyoAlgo) {
      reasons.push(verificationReason("FOTO_ILEGIBLE", { slots: [slot] }));
    }
  }
  return reasons;
}

/** Las fotos que hay que repetir, sin duplicados y en orden estable. */
function fotosARepetir(reasons: VerificationReason[]): DocumentSlot[] {
  const slots = new Set<DocumentSlot>();
  for (const reason of reasons) {
    if (reason.action !== "RETAKE_PHOTO") continue;
    for (const slot of reason.slots) slots.add(slot);
  }
  return [...slots].sort();
}

/** En qué fotos se esperaba encontrar este dato. */
function slotsEsperados(
  type: VerifiedDocumentType,
  kind: DocumentKind,
  campo: string,
): DocumentSlot[] {
  const caras = CARA_ESPERADA[type][campo];
  if (!caras) return slotsOf(kind);
  const slots = caras
    .map((cara) => slotForFace(kind, cara))
    .filter((slot): slot is DocumentSlot => slot !== null);
  return slots.length > 0 ? slots : slotsOf(kind);
}

// ── Recolección y comparación ───────────────────────────────────────────────

/** Una lectura concreta: qué dijo, quién lo dijo y sobre qué foto. */
interface Lectura {
  origen: string;
  slot: DocumentSlot;
  dato: DocverifyField;
}

/** Cada campo → todas las lecturas que aparecieron sobre él. */
type Lecturas = Record<string, Lectura[]>;

/**
 * Aplana las dos caras y todos sus orígenes en un mapa por campo, anotando en
 * qué FOTO apareció cada lectura.
 *
 * Se trabaja sobre `caras` y no sobre el `coincidencias` que ya trae la API
 * porque acá hace falta también la CONFIANZA de cada lectura y la foto de la
 * que salió, y ese resumen solo trae los valores.
 */
function recolectarLecturas(
  result: DocverifyResult,
  kind: DocumentKind,
): Lecturas {
  const lecturas: Lecturas = {};
  for (const [cara, sobre] of Object.entries(result.caras ?? {})) {
    const slot = slotForFace(kind, cara);
    if (!slot) continue;
    for (const [origen, fuente] of Object.entries(sobre?.origenes ?? {})) {
      for (const [campo, dato] of Object.entries(fuente?.campos ?? {})) {
        if (!dato?.valor) continue;
        (lecturas[campo] ??= []).push({
          origen: `${cara}.${origen}`,
          slot,
          dato,
        });
      }
    }
  }
  return lecturas;
}

/** El valor de un campo sin mirar quién lo dijo. Vacío si nadie lo leyó. */
function primerValor(lecturas: Lectura[] | undefined): string {
  return lecturas?.[0]?.dato.valor ?? "";
}

/** Compara un campo entre orígenes y contra la cuenta. */
function evaluarCampo(
  campo: string,
  lecturas: Lectura[],
  user: User,
): { check: FieldCheck; valor: string } {
  const distintos = [
    ...new Set(lecturas.map((l) => normalizarPara(campo, l.dato.valor))),
  ];
  const agrees = distintos.length === 1;

  // Con desacuerdo gana el que el motor leyó con más confianza. No es para dar
  // por bueno el dato —el desacuerdo ya hizo fallar el documento— sino para
  // que la comparación contra la cuenta se haga contra algo razonable y no
  // contra la primera lectura al azar.
  const ganador = lecturas.reduce((mejor, actual) =>
    actual.dato.confianza > mejor.dato.confianza ? actual : mejor,
  );

  const campoCuenta =
    CAMPO_DE_LA_CUENTA[campo as keyof typeof CAMPO_DE_LA_CUENTA];
  const deLaCuenta = campoCuenta ? user[campoCuenta] : null;

  return {
    valor: ganador.dato.valor,
    check: {
      sources: lecturas.length,
      agrees,
      corroborated: agrees && lecturas.length > 1,
      matches:
        deLaCuenta == null
          ? null
          : mismoValor(campo, ganador.dato.valor, deLaCuenta),
      slots: [...new Set(lecturas.map((l) => l.slot))],
    },
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
 * DNI cargado como "49.380.010" y leído como "49380010" es el mismo número.
 *
 * El orden de las palabras SÍ importa: "TEJADA ARAGON" y "ARAGON TEJADA" son
 * apellidos distintos y no hay que darlos por iguales.
 */
function mismoTexto(campo: string, a: string, b: string): boolean {
  const leido = normalizarPara(campo, a);
  const cuenta = normalizarPara(campo, b);
  if (leido === cuenta) return true;

  /**
   * UNA letra de diferencia en el nombre o el apellido no alcanza para hacer
   * fallar un documento. El OCR confunde L con T y M con N sobre una foto con
   * reflejo: "EMITIANO" donde dice "EMILIANO" es un defecto de la cámara, no
   * una identidad distinta, y tratarlo como tal frena a una persona real por
   * algo que no hizo.
   *
   * Solo acá. Un dígito de diferencia en un DNI SÍ es otro documento, y una
   * fecha corrida un día es otra fecha: ahí no hay nada que perdonar.
   *
   * Lo que esto acepta de más, y es a sabiendas: dos nombres reales separados
   * por una letra —MARIA y MARIO— pasan como iguales. Es tolerable porque lo
   * que sostiene la identidad no es esta comparación sola: están además el
   * número de documento (exacto), la fecha de nacimiento (exacta), el CUIL
   * (exacto y con dígito verificador), el control de identidad duplicada y la
   * revisión del administrador.
   *
   * Y no toca la comparación ENTRE orígenes, que se hace aparte con
   * `normalizarPara`: que lo impreso y el código de barras digan cosas
   * distintas sigue siendo la firma del fraude, y ahí la exigencia no se
   * afloja ni una letra.
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
  if (
    campo === "fecha_nacimiento" ||
    campo === "fecha_vencimiento" ||
    campo === "fecha_otorgamiento"
  ) {
    return base.slice(0, 10);
  }
  return base
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Dos clases de licencia son la misma si coinciden letra y subdivisión,
 * ignorando el punto: "B1", "B.1" y "b 1" son la misma clase.
 */
function mismaClase(a: string, b: string): boolean {
  const limpiar = (valor: string) =>
    valor.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return limpiar(a) === limpiar(b);
}

/** Cómo viene un booleano de la API de lectura: "true", "1", "si". */
function esVerdadero(valor: string): boolean {
  const limpio = valor.trim().toLowerCase();
  return (
    limpio === "true" || limpio === "1" || limpio === "si" || limpio === "sí"
  );
}

/** Date → "2026-10-28", en UTC. */
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
