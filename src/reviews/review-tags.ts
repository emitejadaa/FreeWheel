// ============================================================================
//  review-tags.ts — Las características que puede llevar una reseña
// ----------------------------------------------------------------------------
//  Cinco estrellas dicen CUÁNTO gustó, pero no QUÉ pasó. Dos personas ponen 3
//  estrellas: una porque el dueño tardó dos horas en contestar y la otra porque
//  el auto estaba sucio. Ese 3 no le sirve a nadie. Con características, veinte
//  reseñas dejan de ser veinte textos para leer uno por uno y se convierten en
//  un dato contable: "contesta rápido, 18 veces".
//
//  SE GUARDA EL CÓDIGO, NO LA FRASE. `RESPONDE_RAPIDO` y no "Contesta rápido":
//  así la misma reseña se lee en los cinco idiomas del front, y sobre todo, se
//  puede CONTAR. Un texto libre no se cuenta.
//
//  CADA UNA TIENE SU CONTRARIA. Si existe "contesta rápido" tiene que existir
//  "tardó en contestar". Una lista con más elogios que quejas empuja: la persona
//  encuentra dónde tocar para decir algo bueno y no encuentra dónde decir lo que
//  le pasó de verdad.
//
//  LOS DOS LADOS NO PUNTÚAN LO MISMO, y esto se valida acá y no solo en el
//  front. Preguntarle a un dueño si "el auto estaba como en las fotos" no tiene
//  sentido —las fotos las sacó él—, y sin este control alguien podría mandar a
//  mano una reseña marcando a un dueño con "devolvió el auto sucio". El conteo
//  del perfil quedaría diciendo cualquier cosa.
// ============================================================================

/** A quién se le puede poner cada característica. */
export type TagAudience = "OWNER" | "RENTER" | "BOTH";

interface TagDef {
  code: string;
  /** OWNER: la recibe el dueño del auto. RENTER: la recibe quien alquiló. */
  audience: TagAudience;
}

export const REVIEW_TAGS: TagDef[] = [
  // Las que aplican a los dos lados.
  { code: "RESPONDE_RAPIDO", audience: "BOTH" },
  { code: "RESPONDE_TARDE", audience: "BOTH" },
  { code: "TRATO_AMABLE", audience: "BOTH" },
  { code: "TRATO_AGRESIVO", audience: "BOTH" },
  { code: "PUNTUAL", audience: "BOTH" },
  { code: "IMPUNTUAL", audience: "BOTH" },

  // Sobre el dueño: el auto y lo que prometió el aviso.
  { code: "AUTO_COMO_LA_FOTO", audience: "OWNER" },
  { code: "AUTO_DISTINTO", audience: "OWNER" },
  { code: "AUTO_LIMPIO", audience: "OWNER" },
  { code: "AUTO_SUCIO", audience: "OWNER" },
  { code: "SIN_COBROS_EXTRA", audience: "OWNER" },
  { code: "COBROS_INESPERADOS", audience: "OWNER" },

  // Sobre quien alquiló: cómo cuidó y cómo devolvió el auto.
  { code: "CUIDO_EL_AUTO", audience: "RENTER" },
  { code: "MALTRATO_EL_AUTO", audience: "RENTER" },
  { code: "DEVOLVIO_LIMPIO", audience: "RENTER" },
  { code: "DEVOLVIO_SUCIO", audience: "RENTER" },
];

/** Todos los códigos válidos. Es lo que valida el DTO. */
export const REVIEW_TAG_CODES = REVIEW_TAGS.map((t) => t.code);

/**
 * Cuántas se pueden elegir en una misma reseña.
 *
 * Veinte casillas se contestan a desgano o no se contestan; el tope obliga a
 * elegir lo que de verdad pasó.
 */
export const MAX_REVIEW_TAGS = 6;

/**
 * ¿Esta característica se le puede poner a alguien que cumplió este papel?
 *
 * `target` es el papel de QUIEN RECIBE la reseña.
 */
export function tagAppliesTo(
  code: string,
  target: "OWNER" | "RENTER",
): boolean {
  const def = REVIEW_TAGS.find((t) => t.code === code);
  if (!def) return false;
  return def.audience === "BOTH" || def.audience === target;
}
