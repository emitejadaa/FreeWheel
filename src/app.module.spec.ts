import { Test } from "@nestjs/testing";
import { AppModule } from "./app.module";

/**
 * QUE EL SERVIDOR LEVANTE.
 *
 * ── EL ERROR QUE ESTO CUIDA, Y QUE YA PASÓ ────────────────────────────────
 * Un módulo usaba un servicio de otro módulo que NO lo exportaba. TypeScript no
 * dice nada —el import existe y los tipos cierran—, los tests de cada servicio
 * pasan porque arman sus propias dependencias a mano, y el build sale limpio.
 * El error aparece recién cuando Nest arma el grafo de verdad, o sea al
 * levantar el servidor:
 *
 *     Nest can't resolve dependencies of the JobsService (..., ?)
 *
 * O sea: en producción, con todo lo demás ya publicado.
 *
 * Esta prueba arma el grafo ENTERO, igual que main.ts, y falla acá en vez de
 * allá. No prueba ninguna lógica —para eso están las otras quinientas— y
 * justamente por eso vale: es la única que mira cómo encajan las piezas.
 *
 * Si falla, el mensaje de Nest dice exactamente qué provider falta y en qué
 * módulo; casi siempre la respuesta es agregarlo al `exports` del módulo que lo
 * define.
 */
it("EL GRAFO DE MÓDULOS COMPILA ENTERO", async () => {
  const modulo = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  await modulo.close();
}, 30000);
