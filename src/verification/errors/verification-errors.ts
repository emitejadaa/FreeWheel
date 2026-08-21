/**
 * CATÁLOGO DE ERRORES DE LA VERIFICACIÓN DE IDENTIDAD
 *
 * Por qué existe: hasta ahora, cuando una lectura fallaba, lo que quedaba era
 * un `null`. `null` no distingue "la foto no tenía código" de "el código se
 * leyó pero era de otro documento" ni de "el modelo contestó cualquier cosa",
 * y esas tres cosas se arreglan de maneras completamente distintas. Cada falla
 * del pipeline pasa por acá y sale con tres cosas: un CÓDIGO estable, un
 * MENSAJE que dice qué pasó, y una PISTA que dice qué hacer.
 *
 * PRIVACIDAD: `detail` puede traer un pedazo de lo que estaba impreso en el
 * documento (por ejemplo el arranque del payload del código). Por eso estos
 * errores viajan a dos lugares y a ninguno más: la columna `extracted`, que
 * solo ven los administradores, y la respuesta de los endpoints de
 * diagnóstico, donde la persona está mirando su propio documento. NUNCA van a
 * los `reasonCodes` que se le muestran al usuario ni al registro de auditoría.
 */

export type VerificationErrorCode =
  // La imagen que llega
  | "IMAGE_NOT_A_DATA_URL"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_EMPTY"
  | "IMAGE_DOWNLOAD_FAILED"
  // Códigos impresos (PDF417 / QR)
  | "BARCODE_NOT_FOUND"
  | "BARCODE_DECODER_FAILED"
  | "DNI_PDF417_MALFORMED"
  | "DNI_PDF417_INCOMPLETE"
  | "DNI_PDF417_NO_NUMBER"
  | "DNI_PDF417_NO_BIRTHDATE"
  | "DNI_PDF417_NO_NAMES"
  | "LICENSE_CODE_OPAQUE"
  // MRZ del dorso del DNI
  | "MRZ_LINES_MISSING"
  | "MRZ_LINE_LENGTH"
  | "MRZ_CHECKSUM_FAILED"
  | "MRZ_FIELDS_UNREADABLE"
  // Lectura por IA
  | "OCR_NOT_CONFIGURED"
  | "OCR_MODEL_UNAVAILABLE"
  | "OCR_RESPONSE_NOT_JSON"
  | "OCR_RESPONSE_MALFORMED"
  | "OCR_NO_FIELDS"
  | "OCR_FIELD_UNKNOWN"
  | "OCR_FIELD_UNPARSEABLE"
  | "OCR_DOCUMENT_UNRECOGNIZED"
  | "OCR_BOX_INVALID"
  | "OCR_TEXT_TRUNCATED"
  | "OCR_LEGACY_SHAPE"
  | "OCR_CLASSIFICATION_ALIASED"
  // Entrada del diagnóstico
  | "ASSET_URL_UNPARSEABLE"
  | "ASSET_NOT_OWNED"
  | "EXTRACTION_INPUT_INVALID"
  // Comparación
  | "PROFILE_INCOMPLETE"
  | "NO_AUTHORITATIVE_SOURCE"
  // Orquestación
  | "STAGE_TIMEOUT"
  | "STAGE_CRASHED";

export interface VerificationError {
  code: VerificationErrorCode;
  /** Qué pasó, en una frase, sin tecnicismos innecesarios. */
  message: string;
  /** Qué hacer al respecto. */
  hint: string;
  /** Contexto para diagnosticar. Puede traer texto del documento. */
  detail?: string;
}

/**
 * Datos que los mensajes pueden usar. Todos opcionales: cada código toma los
 * que necesita y el resto queda sin usar.
 */
export interface ErrorContext {
  slot?: string;
  /** Variantes de imagen que se probaron al decodificar. */
  variants?: number;
  formats?: string[];
  /** Cuántos campos trajo un payload que se esperaba con más. */
  fieldCount?: number;
  expected?: string | number;
  got?: string | number;
  field?: string;
  value?: string;
  line?: number;
  model?: string;
  bytes?: number;
  limit?: number;
  ms?: number;
  /** Un recorte de lo que se leyó, para reconocerlo de un vistazo. */
  sample?: string;
  cause?: string;
}

type Entry = { message: (ctx: ErrorContext) => string; hint: string };

/** Recorta un texto para poder mostrarlo en un mensaje sin volcarlo entero. */
export function sample(value: string, length = 60): string {
  const limpio = value.replace(/\s+/g, " ").trim();
  return limpio.length <= length ? limpio : `${limpio.slice(0, length)}…`;
}

const list = (values: string[] | undefined): string =>
  (values ?? []).join(", ") || "ninguno";

const CATALOG: Record<VerificationErrorCode, Entry> = {
  IMAGE_NOT_A_DATA_URL: {
    message: () =>
      "La imagen no llegó como dataURL (data:image/...;base64,...).",
    hint:
      "El diagnóstico solo acepta la foto en base64: el servidor no sale a " +
      "descargar una URL que le manden, porque eso lo convertiría en un proxy " +
      "de cualquier dirección. Mandá el contenido del archivo, no un link.",
  },
  IMAGE_TOO_LARGE: {
    message: (c) =>
      `La imagen pesa ${kb(c.bytes)} y el tope es ${kb(c.limit)}.`,
    hint:
      "Achicá la foto antes de mandarla (2000 px de lado largo alcanzan de " +
      "sobra para leer el código) o sacala con menos resolución.",
  },
  IMAGE_EMPTY: {
    message: () => "La imagen llegó vacía: cero bytes.",
    hint: "Volvé a elegir el archivo; puede haberse cortado al subirlo.",
  },
  IMAGE_DOWNLOAD_FAILED: {
    message: (c) =>
      `No se pudo bajar la foto del almacenamiento${c.cause ? `: ${c.cause}` : ""}.`,
    hint:
      "Es un problema entre el backend y Cloudinary, no de la foto. Revisá " +
      "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET.",
  },

  BARCODE_NOT_FOUND: {
    message: (c) =>
      `No apareció ningún código (${list(c.formats)}) en la foto` +
      `${c.slot ? ` de ${c.slot}` : ""}` +
      `${c.variants ? `, probando ${c.variants} variantes de la imagen` : ""}.`,
    hint:
      "El código tiene que entrar ENTERO en la foto, enfocado y sin reflejo. " +
      "En el DNI está en el frente y en la licencia en el dorso. Si la foto " +
      "está movida o el código quedó cortado por el borde, no hay forma de " +
      "leerlo.",
  },
  BARCODE_DECODER_FAILED: {
    message: (c) =>
      `El decodificador de códigos falló${c.cause ? `: ${c.cause}` : ""}.`,
    hint:
      "No es la foto: es el lector. Suele ser que el archivo .wasm de zxing " +
      "no está en el bundle (mirá includeFiles en vercel.json).",
  },
  DNI_PDF417_MALFORMED: {
    message: (c) =>
      "Se leyó un código, pero no tiene la forma del PDF417 del RENAPER " +
      `(campos separados por "@").${c.sample ? ` Empieza con: ${c.sample}` : ""}`,
    hint:
      "Lo más probable es que sea el código de otro documento. Verificá que " +
      "la foto sea la del DNI argentino y no la de la licencia u otra cosa.",
  },
  DNI_PDF417_INCOMPLETE: {
    message: (c) =>
      `El PDF417 se leyó pero trae ${c.fieldCount ?? "pocos"} campos y el ` +
      `formato del RENAPER tiene al menos ${c.expected ?? 8}.` +
      `${c.sample ? ` Empieza con: ${c.sample}` : ""}`,
    hint:
      "El código se leyó a medias. Sacá la foto más cerca y derecha, con el " +
      "código completo dentro del cuadro.",
  },
  LICENSE_CODE_OPAQUE: {
    message: (c) =>
      "El código de la licencia se leyó, pero no trae datos legibles: es un " +
      `identificador o una dirección web.${c.sample ? ` Dice: ${c.sample}` : ""}`,
    hint:
      "No es un error de la foto. Cada jurisdicción imprime lo que quiere en " +
      "ese código y muchas ponen solo un link de validación. La licencia se " +
      "corrobora igual con el texto impreso del frente.",
  },

  DNI_PDF417_NO_NUMBER: {
    message: (c) =>
      "El PDF417 tiene la forma correcta pero el campo del número de " +
      `documento no es un DNI: "${c.got ?? ""}".`,
    hint:
      "Un DNI argentino son 7 u 8 dígitos. Si el código se leyó a medias, " +
      "repetí la foto más cerca y sin reflejo.",
  },
  DNI_PDF417_NO_BIRTHDATE: {
    message: (c) =>
      "El PDF417 tiene la forma correcta pero la fecha de nacimiento no se " +
      `pudo interpretar: "${c.got ?? ""}".`,
    hint:
      "Se espera DD/MM/AAAA en ese campo. Un valor raro ahí suele ser un " +
      "código leído con errores.",
  },
  DNI_PDF417_NO_NAMES: {
    message: () =>
      "El PDF417 tiene la forma correcta pero viene sin apellido o sin nombre.",
    hint:
      "Sin el nombre no sirve como ancla de identidad. Repetí la foto con el " +
      "código completo dentro del cuadro.",
  },

  OCR_BOX_INVALID: {
    message: (c) =>
      `El campo "${c.field ?? "sin nombre"}" vino con una posición que no ` +
      `tiene sentido: ${c.got ?? "?"}.`,
    hint:
      "El dato se conserva; lo que se descarta es la posición, que solo se " +
      "usa para dibujarla sobre la foto en el diagnóstico.",
  },
  OCR_TEXT_TRUNCATED: {
    message: (c) =>
      `El texto completo de la foto se recortó a ${c.limit ?? 0} caracteres ` +
      `(vinieron ${c.got ?? 0}).`,
    hint:
      "Es a propósito: ese texto es solo para mirarlo, y entero se lleva la " +
      "respuesta del modelo puesta.",
  },
  OCR_LEGACY_SHAPE: {
    message: () =>
      "El modelo contestó con el formato viejo (campos sueltos, sin evidencia).",
    hint:
      "Se lee igual. Si se repite siempre, el modelo está ignorando el " +
      "formato pedido y conviene probar otro en GROQ_VISION_MODEL.",
  },
  OCR_CLASSIFICATION_ALIASED: {
    message: (c) =>
      `El modelo dijo "${c.got ?? ""}" para identificar el documento; se ` +
      `interpretó como ${c.expected ?? ""}.`,
    hint:
      "No es un problema. Queda anotado para poder detectar si el modelo " +
      "empieza a contestar de otra forma.",
  },

  ASSET_URL_UNPARSEABLE: {
    message: (c) =>
      `La URL no es un documento guardado por este backend${c.sample ? `: ${c.sample}` : ""}.`,
    hint:
      "Solo se aceptan las URLs que devuelve el propio flujo de subida " +
      "(res.cloudinary.com/<cloud>/image/authenticated/identity/...).",
  },
  ASSET_NOT_OWNED: {
    message: () => "Ese documento pertenece a otra cuenta.",
    hint:
      "Solo se pueden diagnosticar los documentos propios. Subí la foto como " +
      "dataURL o usá una URL de tu propia carpeta.",
  },
  EXTRACTION_INPUT_INVALID: {
    message: (c) =>
      `Lo que llegó para comparar no tiene la forma esperada${c.cause ? `: ${c.cause}` : ""}.`,
    hint:
      "Mandá el objeto `extraction` tal cual lo devolvió " +
      "POST /verification/diagnose/document, sin recortarlo.",
  },

  MRZ_LINES_MISSING: {
    message: (c) =>
      `No se transcribieron las 3 líneas del MRZ del dorso del DNI (llegaron ${c.got ?? 0}).`,
    hint:
      "El MRZ son las tres líneas de letras y signos < del pie del dorso. " +
      "Tienen que entrar completas y enfocadas en la foto.",
  },
  MRZ_LINE_LENGTH: {
    message: (c) =>
      `La línea ${c.line ?? "?"} del MRZ tiene ${c.got ?? "?"} caracteres y ` +
      "las del formato TD1 tienen exactamente 30.",
    hint:
      "Se transcribió de más o de menos. Suele pasar cuando la foto corta el " +
      "borde del documento o hay brillo sobre esas líneas.",
  },
  MRZ_CHECKSUM_FAILED: {
    message: (c) =>
      `El MRZ no cierra: falló el dígito verificador de ${c.field ?? "un campo"}.`,
    hint:
      "Casi siempre es una letra mal transcripta, no un documento falso. Por " +
      "eso el MRZ que no cierra se descarta como fuente en vez de rechazar a " +
      "la persona.",
  },
  MRZ_FIELDS_UNREADABLE: {
    message: (c) =>
      `El MRZ se transcribió pero ${c.field ?? "un campo"} no se pudo interpretar.`,
    hint: "Revisá que las tres líneas del pie del dorso se lean nítidas.",
  },

  OCR_NOT_CONFIGURED: {
    message: () =>
      "La lectura del texto impreso no está configurada en el servidor: falta GROQ_API_KEY.",
    hint:
      "La verificación sigue andando con el PDF417 y el formulario, pero sin " +
      "el texto impreso no hay corroboración. Cargá la clave en el backend.",
  },
  OCR_MODEL_UNAVAILABLE: {
    message: (c) =>
      `El modelo de visión no contestó${c.cause ? `: ${c.cause}` : ""}.`,
    hint:
      "Mirá GET /ai/health (como administrador) para ver qué contestó Groq la " +
      "última vez y qué modelos ofrece hoy.",
  },
  OCR_RESPONSE_NOT_JSON: {
    message: (c) =>
      "El modelo contestó algo que no es JSON." +
      `${c.sample ? ` Contestó: ${c.sample}` : ""}`,
    hint:
      "Suele ser un modelo que se pone a razonar y se queda sin tokens, o uno " +
      "que se niega a mirar documentos. Probá otro en GROQ_VISION_MODEL.",
  },
  OCR_RESPONSE_MALFORMED: {
    message: (c) =>
      "El modelo devolvió un JSON con una forma que no es la pedida" +
      `${c.cause ? `: ${c.cause}` : ""}.`,
    hint:
      "Se esperaba un objeto con `documento`, `campos` y `texto_completo`. " +
      "Si se repite, el modelo no está respetando el formato: probá otro.",
  },
  OCR_NO_FIELDS: {
    message: (c) =>
      `El modelo miró la foto${c.slot ? ` de ${c.slot}` : ""} y no pudo leer ni un campo.`,
    hint:
      "La foto está ilegible para el modelo: poca luz, movida, muy chica o " +
      "con reflejo sobre los datos.",
  },
  OCR_FIELD_UNKNOWN: {
    message: (c) =>
      `El modelo devolvió un campo que no se pidió: "${c.field ?? "sin nombre"}".`,
    hint:
      "Se descarta. No es un problema de la foto; es el modelo agregando " +
      "cosas por su cuenta.",
  },
  OCR_FIELD_UNPARSEABLE: {
    message: (c) =>
      `El campo "${c.field ?? "sin nombre"}" vino como "${c.value ?? ""}" y no se pudo ` +
      `interpretar como ${c.expected ?? "el tipo esperado"}.`,
    hint:
      "El valor se guarda igual como texto crudo para poder mirarlo, pero no " +
      "entra en las comparaciones.",
  },
  OCR_DOCUMENT_UNRECOGNIZED: {
    message: (c) =>
      `El modelo no reconoció qué documento es la foto${c.slot ? ` de ${c.slot}` : ""}.`,
    hint:
      "Si la foto es la correcta, puede ser calidad de imagen. Si no, subiste " +
      "la foto en el lugar equivocado.",
  },

  PROFILE_INCOMPLETE: {
    message: (c) =>
      `Faltan datos cargados a mano en la cuenta para poder comparar: ${c.field ?? "varios"}.`,
    hint:
      "Sin nombre, apellido, fecha de nacimiento, DNI, CUIL y domicilio no " +
      "hay contra qué cruzar lo que dice el documento.",
  },
  NO_AUTHORITATIVE_SOURCE: {
    message: () =>
      "No hubo ninguna fuente confiable: no se pudo leer el PDF417 del DNI ni " +
      "validar el MRZ del dorso.",
    hint:
      "Sin una de las dos, lo único que queda es el texto que leyó un modelo, " +
      "y eso no alcanza para verificar una identidad solo. El caso pasa a " +
      "revisión humana.",
  },

  STAGE_TIMEOUT: {
    message: (c) =>
      `La etapa ${c.slot ?? ""} no terminó dentro de los ${c.ms ?? "?"} ms disponibles.`.trim(),
    hint:
      "La revisión corre dentro del request. Si se repite, subí " +
      "IDENTITY_REVIEW_TIMEOUT_MS (siempre por debajo del maxDuration de " +
      "vercel.json) o achicá las imágenes.",
  },
  STAGE_CRASHED: {
    message: (c) =>
      `La etapa ${c.slot ?? ""} cortó por un error inesperado${c.cause ? `: ${c.cause}` : ""}.`.trim(),
    hint: "Es un error del backend, no de la foto. Mirá el log del servidor.",
  },
};

function kb(bytes: number | undefined): string {
  if (bytes === undefined) return "un tamaño desconocido";
  return `${Math.round(bytes / 1024)} KB`;
}

/** Arma un error del catálogo. Es la ÚNICA forma de crear un VerificationError. */
export function verificationError(
  code: VerificationErrorCode,
  context: ErrorContext = {},
  detail?: string,
): VerificationError {
  const entry = CATALOG[code];
  return {
    code,
    message: entry.message(context),
    hint: entry.hint,
    ...(detail ? { detail } : {}),
  };
}

/** Una línea para el log del servidor. */
export function describeError(error: VerificationError): string {
  return `${error.code}: ${error.message} → ${error.hint}`;
}

/**
 * El resultado de interpretar algo que puede no ser interpretable.
 *
 * Reemplaza al `T | null` que devolvían los parsers: `null` no distinguía "no
 * había nada" de "había algo y estaba mal", y esas dos cosas se arreglan de
 * maneras distintas. `warnings` es para lo que se pudo leer igual pero merece
 * una aclaración (un MRZ cuyos dígitos verificadores no cierran, por ejemplo).
 */
export type ParseResult<T> =
  | { ok: true; data: T; warnings: VerificationError[] }
  | { ok: false; error: VerificationError };

export function parseOk<T>(
  data: T,
  warnings: VerificationError[] = [],
): ParseResult<T> {
  return { ok: true, data, warnings };
}

export function parseFail<T>(error: VerificationError): ParseResult<T> {
  return { ok: false, error };
}

/** Los códigos del catálogo, para poder recorrerlos en los tests. */
export const VERIFICATION_ERROR_CODES = Object.keys(
  CATALOG,
) as VerificationErrorCode[];
