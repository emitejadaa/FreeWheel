/**
 * LAS CLÁUSULAS DEL CONTRATO DE ALQUILER, VERSIONADAS.
 *
 * ── PENDIENTES DE REVISIÓN LEGAL ────────────────────────────────────────────
 * Este texto lo redactó el equipo técnico para que el sistema funcione con
 * reglas claras y coherentes con lo que hace el código. NO lo revisó un
 * abogado todavía. Las preguntas concretas para esa revisión están en
 * CONSULTAS-LEGALES.md (fuera del repo).
 *
 * ── Por qué versionadas ─────────────────────────────────────────────────────
 * Cada contrato guarda la versión de las cláusulas con que se generó, y el
 * hash de su contenido. Cambiar este archivo NO cambia ningún contrato ya
 * generado: los nuevos salen con la versión nueva y los viejos conservan el
 * texto que cada parte aceptó. Por eso, cada vez que se toca una cláusula,
 * HAY QUE SUBIR CONTRACT_CLAUSES_VERSION: dos textos distintos con la misma
 * versión harían imposible saber cuál se aceptó.
 */

export const CONTRACT_CLAUSES_VERSION = "2026-09-22.v1";

/** Parámetros de la política que el texto menciona con números. */
export interface ClausePolicy {
  withdrawalDays: number;
  inspectionHours: number;
  claimResponseHours: number;
  senaPercent: number;
}

export interface Clause {
  id: string;
  title: string;
  text: string;
}

export function buildClauses(p: ClausePolicy): Clause[] {
  return [
    {
      id: "objeto",
      title: "Objeto y partes",
      text:
        "El dueño da en alquiler a quien alquila el vehículo identificado en " +
        "este contrato, por el período indicado, a cambio del precio detallado. " +
        "FreeWheel es la plataforma que pone en contacto a las partes, verifica " +
        "su identidad, administra el cobro y la liquidación por cuenta de ellas " +
        "y media en los reclamos. FreeWheel no es propietaria del vehículo.",
    },
    {
      id: "precio",
      title: "Precio y forma de pago",
      text:
        "El precio se paga en un único pago a través de la plataforma, antes " +
        "del retiro del vehículo. El detalle de cada concepto (alquiler, seña " +
        "incluida en el alquiler, cobertura, comisión de FreeWheel y lo que " +
        "recibe el dueño) forma parte de este contrato. Al dueño se le " +
        "transfiere su parte una vez cerrada la ventana de inspección " +
        "posterior a la devolución.",
    },
    {
      id: "sena",
      title: "Seña penitencial",
      text:
        `Del precio del alquiler, el ${p.senaPercent} % tiene carácter de ` +
        "seña penitencial en los términos del artículo 1059 del Código Civil y " +
        "Comercial: si quien alquila se arrepiente fuera del plazo de " +
        "arrepentimiento, pierde la seña a favor del dueño y se le devuelve el " +
        "resto; si el dueño se arrepiente, debe restituirla doblada. La parte " +
        "que excede el reembolso a la tarjeta se registra como deuda del dueño " +
        "y se descuenta de sus liquidaciones futuras.",
    },
    {
      id: "arrepentimiento",
      title: "Derecho de arrepentimiento",
      text:
        "Quien alquila puede revocar la contratación sin costo ni penalidad " +
        `dentro de los ${p.withdrawalDays} días corridos desde el pago y ` +
        "siempre que no haya retirado el vehículo, conforme al artículo 34 de " +
        "la Ley 24.240 y el artículo 1110 del Código Civil y Comercial. Se " +
        "ejerce desde la plataforma o el botón de arrepentimiento, y se le " +
        "devuelve la totalidad de lo pagado.",
    },
    {
      id: "deposito",
      title: "Depósito en garantía",
      text:
        "Antes del retiro se retiene en la tarjeta de quien alquila el monto " +
        "del depósito indicado. No es un cobro: se libera al cerrarse la " +
        "ventana de inspección sin reclamo, o se cobra total o parcialmente " +
        "para cubrir un daño reclamado y aceptado o resuelto. La retención " +
        "tiene la duración que permita el emisor de la tarjeta; vencida, el " +
        "daño que se reclame se rige por la cláusula de reclamos.",
    },
    {
      id: "entrega",
      title: "Entrega y devolución",
      text:
        "La entrega y la devolución se constatan con los códigos de un solo uso " +
        "que la plataforma genera para cada parte. Confirmar un código deja " +
        "constancia de fecha y hora del hecho.",
    },
    {
      id: "danos",
      title: "Inspección y reclamo por daños",
      text:
        `El dueño tiene ${p.inspectionHours} horas desde la devolución para ` +
        "reportar en la plataforma un daño ocurrido durante el alquiler, con " +
        "fotos y el monto reclamado. Quien alquila tiene " +
        `${p.claimResponseHours} horas para aceptarlo o rechazarlo; sin ` +
        "respuesta o con rechazo, resuelve FreeWheel con la evidencia de ambas " +
        "partes. Este plazo rige el procedimiento de reclamo dentro de la " +
        "plataforma y el uso del depósito en garantía; no limita las acciones " +
        "que la ley reconoce a las partes fuera de ella.",
    },
    {
      id: "uso",
      title: "Uso del vehículo",
      text:
        "Quien alquila se obliga a usar el vehículo con cuidado, a no sacarlo " +
        "del país, a no subalquilarlo ni cederlo, a no dejarlo conducir a " +
        "terceros no autorizados en la plataforma, a no usarlo para transporte " +
        "remunerado de pasajeros ni competencias, y a devolverlo en el lugar y " +
        "la fecha convenidos. Las multas e infracciones cometidas durante el " +
        "alquiler son a su cargo.",
    },
    {
      id: "seguro",
      title: "Seguro",
      text:
        "El dueño declara que el vehículo cuenta con el seguro obligatorio de " +
        "responsabilidad civil vigente y con una póliza que cubre su uso para " +
        "alquiler. El concepto de cobertura detallado en el precio se destina a " +
        "la protección contratada para este alquiler y no constituye un fondo " +
        "de FreeWheel.",
    },
    {
      id: "datos",
      title: "Datos personales",
      text:
        "Los datos de las partes se tratan conforme a la Ley 25.326 y a la " +
        "política de privacidad de la plataforma, solo para ejecutar este " +
        "contrato, prevenir fraudes y cumplir obligaciones legales.",
    },
    {
      id: "firma",
      title: "Aceptación electrónica",
      text:
        "Las partes aceptan este contrato por medios electrónicos desde sus " +
        "cuentas verificadas en la plataforma (Ley 25.506). La plataforma " +
        "conserva, para cada aceptación, la fecha y hora, el identificador de " +
        "la cuenta, el resumen criptográfico (hash) del texto aceptado y los " +
        "datos técnicos de la conexión.",
    },
    {
      id: "jurisdiccion",
      title: "Jurisdicción",
      text:
        "Para cualquier controversia son competentes los tribunales del " +
        "domicilio de quien alquila cuando actúe como consumidor, sin perjuicio " +
        "de las vías de reclamo administrativo previstas en la Ley 24.240.",
    },
  ];
}
