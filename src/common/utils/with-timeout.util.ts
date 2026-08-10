/**
 * Corre una promesa con presupuesto de tiempo y devuelve `fallback` si se
 * agota. Pensado para el entorno serverless: la revisión documental llama a
 * servicios externos dentro del mismo request, y quedarse sin tiempo debe
 * degradar a "revisión manual", nunca tumbar el request con un 500.
 *
 * La promesa original no se cancela (no hay cancelación en JS): simplemente
 * deja de esperarse, y se le adjunta un catch para no dejar un rechazo sin
 * manejar si termina fallando después.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  fallback: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), timeoutMs);
  });

  operation.catch(() => undefined);

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
