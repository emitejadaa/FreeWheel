/**
 * limites.ts — Los topes y las señales contra las reseñas infladas
 * ---------------------------------------------------------------------------
 * EL ATAQUE QUE ESTO FRENA.
 *
 * La reputación es lo único que hace que un desconocido le preste su auto a
 * otro desconocido. Si se puede fabricar, todo lo demás da igual: alguien arma
 * dos o tres cuentas, se alquilan entre ellas, se dejan cinco estrellas, y en
 * un fin de semana tiene un perfil Platino con el que estafar a alguien de
 * verdad. La estafa no es la reseña falsa: la reseña falsa es la herramienta.
 *
 * ── LO QUE YA ERA DIFÍCIL ANTES DE ESTO ───────────────────────────────────
 * Una reseña no se puede escribir de la nada. Hace falta una reserva
 * COMPLETADA y PAGA, las dos partes distintas, y hay una sola reseña por
 * reserva y por autor (índice único en la base). O sea que inflar el perfil ya
 * costaba montar reservas enteras.
 *
 * Lo que faltaba es que ese costo no se pudiera pagar EN SERIE.
 *
 * ── LAS TRES CAPAS, Y POR QUÉ SON TRES ────────────────────────────────────
 *
 * 1. TOPES. Se cortan en el momento, antes de que la acción ocurra, y son
 *    iguales para todos. No acusan a nadie: ponen un techo a la velocidad.
 *    Alguien honesto no los toca nunca; un guion los toca en el primer minuto.
 *
 * 2. SEÑALES. Se calculan después, mirando el PATRÓN y no el acto suelto. Un
 *    acto aislado nunca prueba nada —dos amigos pueden alquilarse el auto— y
 *    un patrón sí. Casi todas terminan en un aviso al panel, no en un castigo.
 *
 * 3. LA SUSPENSIÓN AUTOMÁTICA. Una sola señal la dispara, y a propósito: la
 *    que no puede pasar sin querer. Todo lo demás espera a que alguien mire.
 *
 * ── POR QUÉ SOLO EL ANILLO SUSPENDE SOLO ──────────────────────────────────
 * Suspender es cerrarle la puerta a una persona sin escucharla. Hacerlo con una
 * sospecha estadística es garantizar que tarde o temprano le pase a alguien que
 * no hizo nada, y esa persona no tiene a quién reclamarle a las tres de la
 * mañana. Así que la barra es: solo cuando el patrón NO TIENE una explicación
 * inocente razonable.
 *
 * Cuatro reseñas de ida y cuatro de vuelta con LA MISMA persona en un mes
 * —o sea, ocho alquileres cruzados entre dos cuentas— no es "dos amigos que se
 * prestan el auto": es un circuito. Dos amigos que se prestan el auto de verdad
 * llegan a uno, a dos. Cuatro cada uno, en treinta días, es un guion.
 *
 * ── Y POR QUÉ PUBLICAR NO SUSPENDE NUNCA ──────────────────────────────────
 * Publicar diez autos en un día es raro, no es fraude. Puede ser una agencia
 * chica, alguien cargando su flota, o una prueba. Lo que corresponde en el
 * mundo real es pedirle que demuestre que los autos son suyos, y eso no lo
 * puede decidir un `if`. Así que publicar tiene tope —la velocidad sí se
 * limita— y genera aviso, pero jamás cierra una cuenta.
 */

/* ── Los topes ───────────────────────────────────────────────────────────── */

/**
 * Reseñas que una persona puede escribir en siete días.
 *
 * Seis. Una reseña necesita una reserva terminada, así que escribir seis en una
 * semana es haber cerrado seis alquileres en siete días, que ya es muchísimo
 * para alguien real: un dueño muy activo con tres autos llega a cuatro o cinco.
 * El tope no está para molestarlo a él, está para que el que automatiza no
 * pueda hacer sesenta.
 */
export const RESENAS_POR_SEMANA = 6;

/**
 * Y tres en un día.
 *
 * Es el mismo techo mirado de cerca. Sin esto, las seis de la semana se pueden
 * escribir todas juntas en diez minutos, que es exactamente la forma del
 * guion y no la de una persona.
 */
export const RESENAS_POR_DIA = 3;

/**
 * Publicaciones por día y por semana. Ver la nota de arriba: tope, no castigo.
 *
 * SEIS EN UN DÍA es más de lo que publica cualquier persona de verdad. Quien
 * alquila su auto tiene uno, y a veces dos; una familia con cuatro autos los
 * carga el primer día y después no vuelve a publicar en semanas. El tope no
 * está puesto en lo que hace una persona normal sino bastante por encima, que
 * es lo que lo vuelve inofensivo para ella y sigue sirviendo contra un guion
 * que quiere llenar el catálogo de avisos falsos en una tarde.
 *
 * Quince en la semana, y no cuarenta y dos, por el mismo motivo que las
 * reseñas: el tope diario solo no alcanza si se puede repetir todos los días.
 */
export const PUBLICACIONES_POR_DIA = 6;
export const PUBLICACIONES_POR_SEMANA = 15;

/* ── Las señales ─────────────────────────────────────────────────────────── */

/** La ventana en la que se mira un patrón, en días. */
export const DIAS_DE_LA_VENTANA = 30;

/**
 * Reseñas cruzadas con la MISMA persona que encienden el aviso.
 *
 * Dos de ida y dos de vuelta ya es raro y se avisa; todavía tiene explicación
 * —dos conocidos que se prestan los autos—, así que no pasa nada más.
 */
export const CRUCES_PARA_AVISAR = 2;

/**
 * Y las que disparan la suspensión automática.
 *
 * Cuatro de ida y cuatro de vuelta con la misma persona en treinta días. Ver
 * arriba por qué este número y no uno más bajo.
 */
export const CRUCES_PARA_SUSPENDER = 4;

/**
 * Cuántas reseñas tiene que haber recibido antes de mirar de dónde vienen.
 *
 * Con tres reseñas, que las tres vengan de la misma persona no dice nada: es
 * una cuenta nueva. El patrón empieza a significar algo cuando hay volumen.
 */
export const RECIBIDAS_PARA_MIRAR_CONCENTRACION = 6;

/**
 * Qué parte de las reseñas recibidas puede venir de las dos cuentas que más la
 * reseñaron, antes de que sea raro.
 *
 * Dos tercios. Un perfil sano junta reseñas de mucha gente distinta; uno
 * inflado las junta de las dos cuentas del mismo dueño.
 */
export const CONCENTRACION_MAXIMA = 0.66;

/** Días en los que una cuenta se considera nueva. */
export const DIAS_DE_CUENTA_NUEVA = 7;

/**
 * Reseñas recibidas por una cuenta nueva que encienden el aviso.
 *
 * Una cuenta de tres días con ocho reseñas no es imposible, pero es lo que hace
 * un perfil armado para usar YA, que es justo la forma de esta estafa: el
 * atacante no quiere un perfil bueno, quiere uno bueno rápido.
 */
export const RECIBIDAS_DE_CUENTA_NUEVA = 6;

/* ── Los tipos ───────────────────────────────────────────────────────────── */

/** Qué se le puede contar a esta política sobre una cuenta. */
export interface ActividadDeLaCuenta {
  /** Reseñas que ESCRIBIÓ en las últimas 24 horas y en los últimos 7 días. */
  resenasEscritasHoy: number;
  resenasEscritasEnLaSemana: number;
  /** Publicaciones que creó en las últimas 24 horas y en los últimos 7 días. */
  publicacionesHoy: number;
  publicacionesEnLaSemana: number;
  /**
   * Por cada OTRA cuenta con la que intercambió reseñas en la ventana: cuántas
   * le escribió y cuántas recibió de ella.
   */
  cruces: { otroId: string; escritas: number; recibidas: number }[];
  /** Reseñas recibidas en total. */
  recibidas: number;
  /** De ellas, cuántas vienen de las dos cuentas que más la reseñaron. */
  recibidasDeLosDosQueMas: number;
  /** Antigüedad de la cuenta, en días. */
  diasDeAntiguedad: number;
}

export type TipoDeSenal =
  /** Dos cuentas que se reseñan entre sí una y otra vez. */
  | "ANILLO_DE_RESENAS"
  /** Lo mismo, pero todavía con explicación posible. */
  | "RESENAS_CRUZADAS"
  /** Casi todas sus reseñas vienen de dos cuentas. */
  | "RESENAS_CONCENTRADAS"
  /** Cuenta recién creada con muchas reseñas encima. */
  | "REPUTACION_DEMASIADO_RAPIDA"
  /** Muchas publicaciones en un día. Avisa, nunca suspende. */
  | "PUBLICACIONES_EN_RAFAGA";

export interface Senal {
  tipo: TipoDeSenal;
  /** Si por sí sola alcanza para cerrar la cuenta sin que nadie la mire. */
  suspende: boolean;
  /** Los números que la encendieron, para que el panel no tenga que adivinar. */
  detalle: Record<string, unknown>;
}

/* ── Los topes, aplicados ────────────────────────────────────────────────── */

export interface Veredicto {
  permitido: boolean;
  /** Código estable para el front. */
  motivo: string | null;
  /** Cuánto falta para poder de nuevo, en horas. Null si no aplica. */
  horasDeEspera: number | null;
}

const PERMITIDO: Veredicto = {
  permitido: true,
  motivo: null,
  horasDeEspera: null,
};

/**
 * ¿Puede escribir otra reseña?
 *
 * Se mira el día antes que la semana a propósito: si tocó los dos topes, lo que
 * sirve saber es cuándo puede de nuevo, y el del día vence mucho antes.
 */
export function puedeResenar(actividad: ActividadDeLaCuenta): Veredicto {
  if (actividad.resenasEscritasHoy >= RESENAS_POR_DIA) {
    return {
      permitido: false,
      motivo: "RESENAS_POR_DIA",
      horasDeEspera: 24,
    };
  }
  if (actividad.resenasEscritasEnLaSemana >= RESENAS_POR_SEMANA) {
    return {
      permitido: false,
      motivo: "RESENAS_POR_SEMANA",
      horasDeEspera: 24 * 7,
    };
  }
  return PERMITIDO;
}

/** ¿Puede publicar otro auto? Mismo criterio. */
export function puedePublicar(actividad: ActividadDeLaCuenta): Veredicto {
  if (actividad.publicacionesHoy >= PUBLICACIONES_POR_DIA) {
    return {
      permitido: false,
      motivo: "PUBLICACIONES_POR_DIA",
      horasDeEspera: 24,
    };
  }
  if (actividad.publicacionesEnLaSemana >= PUBLICACIONES_POR_SEMANA) {
    return {
      permitido: false,
      motivo: "PUBLICACIONES_POR_SEMANA",
      horasDeEspera: 24 * 7,
    };
  }
  return PERMITIDO;
}

/* ── Las señales ─────────────────────────────────────────────────────────── */

/**
 * Qué tiene de raro esta cuenta.
 *
 * Devuelve TODAS las señales encendidas y no la primera: dos señales distintas
 * sobre la misma cuenta es un dato más fuerte que cualquiera de las dos, y
 * quien mire el panel tiene que verlas juntas.
 *
 * El orden es de más grave a menos, porque así se lee la lista.
 */
export function senalesDe(actividad: ActividadDeLaCuenta): Senal[] {
  const senales: Senal[] = [];

  /*
    EL ANILLO. La única que suspende sola.

    Se mira el MÍNIMO entre lo que escribió y lo que recibió de la misma
    persona, no la suma: lo que define un circuito es que vaya en las dos
    direcciones. Diez reseñas escritas a alguien que nunca le contestó ninguna
    no es un anillo —es alguien que alquila seguido el mismo auto—, y sumarlas
    lo trataría igual.
  */
  const cruceMasFuerte = actividad.cruces.reduce(
    (peor, c) => {
      const ida = Math.min(c.escritas, c.recibidas);
      return ida > peor.ida ? { ida, cruce: c } : peor;
    },
    { ida: 0, cruce: null as ActividadDeLaCuenta["cruces"][number] | null },
  );

  if (cruceMasFuerte.ida >= CRUCES_PARA_SUSPENDER) {
    senales.push({
      tipo: "ANILLO_DE_RESENAS",
      suspende: true,
      detalle: {
        conLaCuenta: cruceMasFuerte.cruce?.otroId,
        leEscribio: cruceMasFuerte.cruce?.escritas,
        recibioDeElla: cruceMasFuerte.cruce?.recibidas,
        enDias: DIAS_DE_LA_VENTANA,
      },
    });
  } else if (cruceMasFuerte.ida >= CRUCES_PARA_AVISAR) {
    senales.push({
      tipo: "RESENAS_CRUZADAS",
      suspende: false,
      detalle: {
        conLaCuenta: cruceMasFuerte.cruce?.otroId,
        leEscribio: cruceMasFuerte.cruce?.escritas,
        recibioDeElla: cruceMasFuerte.cruce?.recibidas,
        enDias: DIAS_DE_LA_VENTANA,
      },
    });
  }

  // De dónde vienen las reseñas que tiene.
  if (actividad.recibidas >= RECIBIDAS_PARA_MIRAR_CONCENTRACION) {
    const parte = actividad.recibidasDeLosDosQueMas / actividad.recibidas;
    if (parte > CONCENTRACION_MAXIMA) {
      senales.push({
        tipo: "RESENAS_CONCENTRADAS",
        suspende: false,
        detalle: {
          recibidas: actividad.recibidas,
          deLasDosQueMas: actividad.recibidasDeLosDosQueMas,
          porcentaje: Math.round(parte * 100),
        },
      });
    }
  }

  // Una cuenta de esta semana con la reputación de una de hace un año.
  if (
    actividad.diasDeAntiguedad <= DIAS_DE_CUENTA_NUEVA &&
    actividad.recibidas >= RECIBIDAS_DE_CUENTA_NUEVA
  ) {
    senales.push({
      tipo: "REPUTACION_DEMASIADO_RAPIDA",
      suspende: false,
      detalle: {
        diasDeAntiguedad: actividad.diasDeAntiguedad,
        recibidas: actividad.recibidas,
      },
    });
  }

  // Publicar en ráfaga avisa y nunca suspende. Ver la cabecera del archivo.
  if (actividad.publicacionesHoy >= PUBLICACIONES_POR_DIA) {
    senales.push({
      tipo: "PUBLICACIONES_EN_RAFAGA",
      suspende: false,
      detalle: {
        hoy: actividad.publicacionesHoy,
        enLaSemana: actividad.publicacionesEnLaSemana,
      },
    });
  }

  return senales;
}

/** Si alguna de las señales alcanza para cerrar la cuenta sin intervención. */
export const hayQueSuspender = (senales: Senal[]): boolean =>
  senales.some((s) => s.suspende);
