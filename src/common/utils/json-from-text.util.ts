/**
 * SACAR UN JSON DE LO QUE CONTESTA UN MODELO
 *
 * Dos utilidades que hacen falta en todos lados donde se le pide JSON a un
 * modelo de lenguaje, porque ninguno contesta solamente lo que se le pidió.
 */

/**
 * Saca de la respuesta todo lo que no es la respuesta.
 *
 * POR QUÉ EXISTE: los modelos de razonamiento (qwen3, deepseek-r1) escriben
 * primero su análisis dentro de <think>...</think> y recién después contestan.
 * Ese análisis se lleva casi todos los tokens del tope, así que lo que llegaba
 * era un <think> cortado por la mitad, sin una sola llave, y la revisión
 * terminaba en "no se pudo interpretar la revisión automática" con CUALQUIER
 * imagen. Un <think> sin cerrar es exactamente eso: la respuesta se cortó y
 * después no viene nada.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<think>[\s\S]*$/i, " ")
    .replace(/```json/gi, " ")
    .replace(/```/g, " ")
    .trim();
}

/**
 * El primer objeto JSON COMPLETO del texto, contando llaves y salteando las
 * que estén dentro de un string. El `/\{[\s\S]*\}/` de antes agarraba desde la
 * primera llave que apareciera en el razonamiento hasta la última del texto,
 * así que devolvía algo que no parsea aunque el JSON de verdad estuviera ahí.
 */
export function findJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  // Llegar acá es una respuesta cortada: hay apertura y nunca cierre.
  return null;
}
