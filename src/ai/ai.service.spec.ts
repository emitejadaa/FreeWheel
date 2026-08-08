import { ConfigService } from "@nestjs/config";
import { AiService } from "./ai.service";

/**
 * Lo que se prueba acá es la DECISIÓN que toma el servicio con lo que contesta el
 * modelo, no el modelo en sí (eso vive en Groq y no se puede probar desde acá).
 *
 * Importa porque el control anterior preguntaba "¿esta imagen muestra un
 * automóvil? SI o NO", y con esa pregunta la foto de un auto de juguete contesta
 * SI: es, literalmente, la imagen de un automóvil. El control existía y no
 * filtraba nada. Estas pruebas fijan que un juguete, un dibujo o una maqueta
 * queden RECHAZADOS aunque el modelo reconozca la forma de un auto.
 */
describe("AiService.vision", () => {
  /** Servicio con la clave cargada y una respuesta de Groq preparada. */
  function conRespuesta(content: string) {
    const config = { get: () => "clave-de-prueba" } as unknown as ConfigService;
    const service = new AiService(config);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
    }) as unknown as typeof fetch;

    return service;
  }

  /** El texto del prompt que se le mandó a Groq en la última llamada. */
  function promptEnviado(): string {
    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { body: string },
    ];
    return init.body;
  }

  const IMAGEN = "data:image/jpeg;base64,AAAA";

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("accepts a photo of a real car", async () => {
    const service = conRespuesta(
      '{"es_vehiculo": true, "es_real": true, "que_es": "auto sedán gris", "motivo": "Es un auto real fotografiado en la calle."}',
    );

    const result = await service.vision(IMAGEN);

    expect(result.isVehicle).toBe(true);
    expect(result.detected).toBe("auto sedán gris");
  });

  it("rejects a toy car even though it has the shape of a car", async () => {
    const service = conRespuesta(
      '{"es_vehiculo": true, "es_real": false, "que_es": "auto a batería de juguete", "motivo": "Es un auto de juguete a batería para chicos, no un vehículo real."}',
    );

    const result = await service.vision(IMAGEN);

    expect(result.isVehicle).toBe(false);
    expect(result.reason).toContain("juguete");
  });

  it("rejects a drawing or a render of a car", async () => {
    const service = conRespuesta(
      '{"es_vehiculo": true, "es_real": false, "que_es": "render 3D", "motivo": "Es una imagen generada, no una fotografía de un auto."}',
    );

    expect((await service.vision(IMAGEN)).isVehicle).toBe(false);
  });

  it("rejects something that is not a vehicle at all", async () => {
    const service = conRespuesta(
      '{"es_vehiculo": false, "es_real": false, "que_es": "un perro", "motivo": "La imagen muestra un perro."}',
    );

    const result = await service.vision(IMAGEN);

    expect(result.isVehicle).toBe(false);
    expect(result.reason).toContain("perro");
  });

  it("does not reject a good photo just because the model omitted es_real", async () => {
    // Un campo que falta no es una respuesta negativa: rechazar por eso dejaría
    // afuera fotos perfectamente válidas.
    const service = conRespuesta('{"es_vehiculo": true, "que_es": "camioneta"}');

    expect((await service.vision(IMAGEN)).isVehicle).toBe(true);
  });

  it("still understands a plain SI/NO answer", async () => {
    // Algunos modelos ignoran el pedido de JSON. Sirve para descartar lo
    // evidente, aunque no distinga un juguete.
    expect((await conRespuesta("NO").vision(IMAGEN)).isVehicle).toBe(false);
    expect((await conRespuesta("SI").vision(IMAGEN)).isVehicle).toBe(true);
  });

  it("reports 'not configured' instead of silently passing when there is no key", async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new AiService(config);

    const result = await service.vision(IMAGEN);

    // null es "no se pudo verificar", NUNCA "está bien": es lo que dejó pasar la
    // foto de un perro como foto de un auto.
    expect(result.isVehicle).toBeNull();
    expect(result.code).toBe("not_configured");
  });

  /**
   * EL IDIOMA DEL MOTIVO
   *
   * El motivo lo escribe el modelo y se le muestra tal cual a la persona. Con la
   * app en inglés, una pantalla en inglés mostraba la explicación en castellano:
   * justo la parte que hace falta entender para arreglar la foto. Ahora el front
   * manda el idioma elegido y el prompt le pide al modelo que escriba en ese
   * idioma; los respaldos escritos a mano también cambian.
   */
  it("asks the model for the reason in the chosen language", async () => {
    const service = conRespuesta('{"es_vehiculo": true, "es_real": true}');

    await service.vision(IMAGEN, "en");

    expect(promptEnviado()).toContain("inglés");
  });

  it("defaults to Spanish when no language is given", async () => {
    const service = conRespuesta('{"es_vehiculo": true, "es_real": true}');

    await service.vision(IMAGEN);

    expect(promptEnviado()).toContain("español");
  });

  it("uses the chosen language for the fallback reason too", async () => {
    // El modelo contestó "NO" en lugar del JSON pedido: ahí el motivo lo escribe
    // el backend, y también tiene que salir en el idioma elegido.
    const service = conRespuesta("NO");

    const result = await service.vision(IMAGEN, "en");

    expect(result.isVehicle).toBe(false);
    expect(result.reason).toBe("The image does not show a vehicle.");
  });
});

/**
 * PROBAR LOS MODELOS DE VERDAD
 *
 * `health()` comparaba los nombres configurados contra la lista de Groq, y con eso
 * decía si estaban "disponibles". Pero estar en la lista no es lo mismo que
 * funcionar: un modelo puede estar listado y contestar 401 (clave mala) o 429
 * (cuota agotada). Con ?probe=1 se le manda una imagen de 1x1 a cada uno y se
 * informa cuál contestó, que es lo que hace falta para saber qué poner en
 * GROQ_VISION_MODEL.
 */
describe("AiService.health con prueba de modelos", () => {
  // Un ConfigService por CLAVE y no uno que devuelve lo mismo para todo: con el
  // segundo, GROQ_VISION_MODEL devolvía la clave de la API y se colaba como si
  // fuera el nombre de un modelo.
  const config = {
    get: (name: string) => (name === "GROQ_API_KEY" ? "clave-de-prueba" : undefined),
  } as unknown as ConfigService;

  afterEach(() => jest.restoreAllMocks());

  /** Groq lista los modelos, y cada prueba responde lo que se le indique. */
  function conModelos(ids: string[], respuestaPorModelo: Record<string, number>) {
    global.fetch = jest.fn((url: string, init?: { body?: string }) => {
      if (String(url).includes("/models")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: ids.map((id) => ({ id })) }),
        });
      }
      const model = String(JSON.parse(init?.body ?? "{}").model);
      const status = respuestaPorModelo[model] ?? 200;
      return Promise.resolve({
        ok: status === 200,
        status,
        text: () => Promise.resolve(`{"error":{"message":"estado ${status}"}}`),
        json: () => Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
      });
    }) as unknown as typeof fetch;
    return new AiService(config);
  }

  const SCOUT = "meta-llama/llama-4-scout-17b-16e-instruct";
  const MAVERICK = "meta-llama/llama-4-maverick-17b-128e-instruct";

  it("does not probe unless it is asked to", async () => {
    const service = conModelos([SCOUT, MAVERICK], {});

    const result = await service.health();

    expect(result.probed).toBeUndefined();
    // Solo el pedido de la lista de modelos, ninguna prueba.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("reports which vision models actually answer", async () => {
    const service = conModelos([SCOUT, MAVERICK], { [MAVERICK]: 429 });

    const result = await service.health(true);

    expect(result.probed).toEqual(
      expect.arrayContaining([
        { model: SCOUT, ok: true },
        expect.objectContaining({ model: MAVERICK, ok: false }),
      ]),
    );
    // Uno anda, así que no hay problema que avisar.
    expect(result.problem).toBeUndefined();
  });

  it("explains the problem when the models exist but none answers", async () => {
    const service = conModelos([SCOUT, MAVERICK], { [SCOUT]: 401, [MAVERICK]: 401 });

    const result = await service.health(true);

    expect(result.probed?.every((p) => !p.ok)).toBe(true);
    expect(result.problem).toContain("401");
  });
});
