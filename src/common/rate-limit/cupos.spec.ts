/**
 * LOS CUPOS QUE NO SE PUEDEN SACAR SIN QUE NADIE SE ENTERE.
 *
 * Las llamadas a la IA y las subidas de fotos cuestan plata de verdad: cuota
 * de nuestra clave de Groq y espacio en nuestra cuenta de Cloudinary. El tope
 * de cada una es una línea de metadata arriba del método, o sea que se puede
 * borrar sin romper nada: compila, los tests pasan, y el día que alguien deje
 * un guion corriendo nos enteramos por la factura.
 *
 * Esta prueba lee esa metadata y exige que exista, que sea diaria y que se
 * cuente contra una persona y no contra toda la plataforma. No comprueba que
 * el contador funcione —de eso se ocupa rate-limit.service.spec.ts—, sino que
 * esté puesto.
 */
import "reflect-metadata";
import { AiController } from "../../ai/ai.controller";
import { MediaController } from "../../media/media.controller";
import { OptionalJwtAuthGuard } from "../../auth/guards/optional-jwt-auth.guard";
import { SENSITIVE_RATE_LIMIT_KEY } from "./sensitive-rate-limit.decorator";
import type { SensitiveRateLimitOptions } from "./sensitive-rate-limit.decorator";
import { SensitiveRateLimitGuard } from "./sensitive-rate-limit.guard";

const UN_DIA = 24 * 60 * 60;

/**
 * El método de un controller, tomado por su descriptor.
 *
 * Se busca así y no como `AiController.prototype.chat` porque eso es una
 * referencia suelta a un método y el linter la marca: acá no se lo llama
 * nunca, solo se le lee la metadata que le dejaron los decoradores.
 */
const metodoDe = (proto: object, nombre: string): object =>
  Object.getOwnPropertyDescriptor(proto, nombre)?.value as object;

/** El cupo puesto sobre un método, o undefined si no tiene. */
const cupoDe = (metodo: object): SensitiveRateLimitOptions | undefined =>
  Reflect.getMetadata(SENSITIVE_RATE_LIMIT_KEY, metodo) as
    | SensitiveRateLimitOptions
    | undefined;

/** Los guards puestos sobre un método, en el orden en que van a correr. */
const guardsDe = (metodo: object): unknown[] =>
  (Reflect.getMetadata("__guards__", metodo) as unknown[]) ?? [];

const ai = (nombre: string) => metodoDe(AiController.prototype, nombre);
const media = (nombre: string) => metodoDe(MediaController.prototype, nombre);

describe("Los cupos de lo que cuesta plata", () => {
  const rutas: Array<[string, object]> = [
    ["POST /ai/chat", ai("chat")],
    ["POST /ai/vision", ai("vision")],
    ["POST /ai/transcribe", ai("transcribe")],
    ["POST /media/cloudinary-signature", media("signUpload")],
  ];

  it.each(rutas)("%s tiene un cupo diario por persona", (_nombre, metodo) => {
    const cupo = cupoDe(metodo);
    expect(cupo).toBeDefined();
    // Diario: un tope por minuto frena una ráfaga, no a alguien que deja un
    // guion toda la noche a ritmo tranquilo.
    expect(cupo?.windowSec).toBe(UN_DIA);
    // Contra una persona (o su IP si no tiene cuenta), nunca global: un tope
    // global lo agota uno y deja sin servicio a todos los demás.
    expect(["user", "ip+user"]).toContain(cupo?.by);
    expect(cupo?.limit).toBeGreaterThan(0);
  });

  it("y el cupo es holgado para una persona de verdad", () => {
    /*
      Los números salen de lo que hace alguien que usa la página en serio, no
      de lo que parece prudente. Un tope por debajo de eso no protege de nada:
      molesta a quien no hizo nada y el que quiere abusar igual tiene un día
      entero de margen.

      Seis avisos por día (antifraude/limites.ts) de seis fotos cada uno son
      treinta y seis fotos y treinta y seis revisiones.
    */
    expect(cupoDe(ai("vision"))?.limit).toBeGreaterThanOrEqual(36 * 2);
    expect(cupoDe(media("signUpload"))?.limit).toBeGreaterThanOrEqual(36 * 2);
    expect(cupoDe(ai("chat"))?.limit).toBeGreaterThanOrEqual(50);
  });

  it("EN EL CHAT, LA SESIÓN SE RESUELVE ANTES DE CONTAR", () => {
    /*
      El asistente es público, así que no tiene JwtAuthGuard. Sin el guard
      opcional, `req.user` nunca se llena y el cupo se cuenta SOLO por IP: en
      una red compartida —una escuela, una oficina— el primero que pregunta
      mucho deja sin asistente a todos los demás.

      El orden importa y por eso se prueba: si el guard del cupo corriera
      primero, contaría antes de saber quién es, que es exactamente lo mismo
      que no tenerlo.
    */
    const guards = guardsDe(ai("chat"));
    expect(guards).toContain(OptionalJwtAuthGuard);
    expect(guards).toContain(SensitiveRateLimitGuard);
    expect(guards.indexOf(OptionalJwtAuthGuard)).toBeLessThan(
      guards.indexOf(SensitiveRateLimitGuard),
    );
  });
});
