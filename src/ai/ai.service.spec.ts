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
    const service = conRespuesta(
      '{"es_vehiculo": true, "que_es": "camioneta"}',
    );

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
    get: (name: string) =>
      name === "GROQ_API_KEY" ? "clave-de-prueba" : undefined,
  } as unknown as ConfigService;

  /**
   * Cuerpo del error que devuelve Groq, por modelo. Lo completa la prueba que
   * necesita un mensaje concreto (por ejemplo "invalid image data"); el resto usa
   * uno genérico.
   */
  const respuestaDeError: Record<string, string> = {};

  afterEach(() => {
    jest.restoreAllMocks();
    for (const clave of Object.keys(respuestaDeError)) {
      delete respuestaDeError[clave];
    }
  });

  /** Groq lista los modelos, y cada prueba responde lo que se le indique. */
  function conModelos(
    ids: string[],
    respuestaPorModelo: Record<string, number>,
  ) {
    global.fetch = jest.fn((url: string, init?: { body?: string }) => {
      if (String(url).includes("/models")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: ids.map((id) => ({ id })) }),
        });
      }
      const pedido = JSON.parse(init?.body ?? "{}") as { model?: string };
      const model = String(pedido.model);
      const status = respuestaPorModelo[model] ?? 200;
      return Promise.resolve({
        ok: status === 200,
        status,
        text: () =>
          Promise.resolve(
            respuestaDeError[model] ??
              `{"error":{"message":"estado ${status}"}}`,
          ),
        json: () =>
          Promise.resolve({ choices: [{ message: { content: "ok" } }] }),
      });
    }) as unknown as typeof fetch;
    return new AiService(config);
  }

  const SCOUT = "meta-llama/llama-4-scout-17b-16e-instruct";
  const MAVERICK = "meta-llama/llama-4-maverick-17b-128e-instruct";
  // El primero de la lista de respaldo del servicio: Groq dio de baja los dos
  // llama-4 y mandó a migrar a éste, así que también se prueba.
  const QWEN = "qwen/qwen3.6-27b";

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
    const service = conModelos([SCOUT, MAVERICK], {
      [SCOUT]: 401,
      [MAVERICK]: 401,
      [QWEN]: 401,
    });

    const result = await service.health(true);

    expect(result.probed?.every((p) => !p.ok)).toBe(true);
    expect(result.problem).toContain("401");
  });
  it("no da por roto un modelo que solo rechazó la imagen de prueba", async () => {
    // Esto es lo que pasó de verdad en producción: qwen existía, la clave
    // funcionaba, y contestaba `400 invalid image data` a la imagen de prueba de
    // 1x1 que se mandaba antes. El panel lo mostraba como "la revisión no está
    // funcionando", que era exactamente al revés.
    const service = conModelos([QWEN], {
      [QWEN]: 400,
      [SCOUT]: 404,
      [MAVERICK]: 404,
    });
    respuestaDeError[QWEN] =
      '{"error":{"message":"invalid image data","type":"invalid_request_error"}}';

    const result = await service.health(true);

    const qwen = result.probed?.find((p) => p.model === QWEN);
    expect(qwen?.ok).toBe(false);
    expect(qwen?.testImageRejected).toBe(true);
    // No se avisa de un problema que no existe...
    expect(result.problem).toBeUndefined();
    // ...y se explica qué hacer para saberlo de verdad.
    expect(result.note).toContain(QWEN);
    expect(result.note).toContain("foto");
  });

  it("un 404 de modelo inexistente sigue siendo un problema de verdad", async () => {
    const service = conModelos([QWEN], { [QWEN]: 404 });
    respuestaDeError[QWEN] =
      '{"error":{"message":"The model does not exist","code":"model_not_found"}}';

    const result = await service.health(true);

    expect(
      result.probed?.find((p) => p.model === QWEN)?.testImageRejected,
    ).toBeUndefined();
  });
});

/**
 * EL JSON QUE NUNCA LLEGABA
 *
 * La revisión de documentos contestaba `{"matches": null, "code":
 * "unreadable"}` con cualquier foto. La clave de Groq estaba bien y el modelo
 * existía: contestaba 200. Lo que pasaba es que el modelo de turno (qwen3) es
 * de los que "piensan en voz alta": escribe su análisis dentro de
 * <think>...</think> antes de contestar, y con el tope de 400 tokens que había
 * el análisis se comía la respuesta entera. Lo que llegaba era un <think>
 * cortado por la mitad, sin una sola llave, así que no había JSON que
 * interpretar. Con cualquier imagen, siempre.
 *
 * Estas pruebas fijan las tres defensas: que el razonamiento no viaje en el
 * contenido, que si igual llega se lo descarte, y que un modelo que no devuelve
 * el JSON pedido se trate como un modelo inservible (se prueba el siguiente) en
 * vez de darle a la persona un error del que no puede salir.
 */
describe("AiService.inspectDocument", () => {
  const config = {
    get: (name: string) =>
      name === "GROQ_API_KEY" ? "clave-de-prueba" : undefined,
  } as unknown as ConfigService;

  const IMAGEN = "data:image/jpeg;base64,AAAA";
  const JSON_OK =
    '{"corresponde": true, "legible": true, "tipo_detectado": "DNI argentino", ' +
    '"numero": "12345678", "nombre": "JUAN PEREZ", "vencimiento": "2030-02-15", ' +
    '"motivo": "Se ve el frente del DNI."}';

  /** Groq contesta lo que se le indique por modelo (texto, o {status, body}). */
  function conRespuestas(
    porModelo: Record<string, string | { status: number; body: string }>,
    porDefecto: string | { status: number; body: string } = JSON_OK,
  ) {
    global.fetch = jest.fn((_url: string, init?: { body?: string }) => {
      const pedido = JSON.parse(init?.body ?? "{}") as { model?: string };
      const respuesta = porModelo[String(pedido.model)] ?? porDefecto;

      if (typeof respuesta !== "string") {
        return Promise.resolve({
          ok: false,
          status: respuesta.status,
          text: () => Promise.resolve(respuesta.body),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: respuesta },
                finish_reason: respuesta.includes("</think>")
                  ? "stop"
                  : respuesta.includes("<think>")
                    ? "length"
                    : "stop",
              },
            ],
          }),
      });
    }) as unknown as typeof fetch;

    return new AiService(config);
  }

  /** Los cuerpos que se le mandaron a Groq, ya parseados. */
  function pedidos(): Record<string, unknown>[] {
    return (global.fetch as jest.Mock).mock.calls.map(
      ([, init]) =>
        JSON.parse((init as { body: string }).body) as Record<string, unknown>,
    );
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("le pide a Groq el JSON y el razonamiento fuera del contenido", async () => {
    const service = conRespuestas({});

    await service.inspectDocument(IMAGEN, "DNI_FRONT");

    expect(pedidos()[0]).toMatchObject({
      response_format: { type: "json_object" },
      reasoning_format: "hidden",
    });
  });

  it("entiende la respuesta aunque el modelo razone antes de contestar", async () => {
    const service = conRespuestas(
      {},
      `<think>La imagen muestra una tarjeta con foto. {no es JSON}</think>\n${JSON_OK}`,
    );

    const result = await service.inspectDocument(IMAGEN, "DNI_FRONT");

    expect(result.matches).toBe(true);
    expect(result.documentNumber).toBe("12345678");
  });

  it("prueba el siguiente modelo cuando uno se queda razonando y no contesta", async () => {
    // Exactamente el caso de producción: el primer modelo agota el tope de
    // tokens pensando y la respuesta llega cortada, sin JSON.
    const service = conRespuestas({
      "qwen/qwen3.6-27b": "<think>Veamos la imagen con cuidado, primero el",
    });

    const result = await service.inspectDocument(IMAGEN, "DNI_FRONT");

    expect(result.matches).toBe(true);
    expect(pedidos().length).toBeGreaterThan(1);
  });

  it("repite el pedido sin los parámetros extra si el modelo no los acepta", async () => {
    let primeraVez = true;
    global.fetch = jest.fn(() => {
      if (primeraVez) {
        primeraVez = false;
        return Promise.resolve({
          ok: false,
          status: 400,
          text: () =>
            Promise.resolve(
              '{"error":{"message":"response_format is not supported for this model"}}',
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ choices: [{ message: { content: JSON_OK } }] }),
      });
    }) as unknown as typeof fetch;

    const result = await new AiService(config).inspectDocument(
      IMAGEN,
      "DNI_FRONT",
    );

    expect(result.matches).toBe(true);
    // El reintento es sobre el MISMO modelo, ya sin los extras.
    const [conExtras, sinExtras] = pedidos();
    expect(conExtras.model).toBe(sinExtras.model);
    expect(sinExtras.response_format).toBeUndefined();
  });

  it("avisa 'unreadable' solo si ningún modelo devolvió el JSON", async () => {
    const service = conRespuestas({}, "No puedo ayudarte con eso.");

    const result = await service.inspectDocument(IMAGEN, "DNI_FRONT");

    expect(result.matches).toBeNull();
    expect(result.code).toBe("unreadable");
    // Y el motivo sale en el idioma que se pidió, como el resto.
    expect(
      (await service.inspectDocument(IMAGEN, "DNI_FRONT", "en")).reason,
    ).toBe("The automatic review could not be interpreted.");
  });

  it("guarda lo que contestó el modelo para poder diagnosticarlo", async () => {
    // Sin esto, la falla es invisible: la pantalla dice "no se pudo
    // interpretar" y no hay forma de saber si el modelo se puso a razonar, se
    // negó a mirar un documento o contestó en prosa.
    const service = conRespuestas({}, "No puedo ayudarte con eso.");
    await service.inspectDocument(IMAGEN, "DNI_FRONT");

    const health = await service.health(false, true);
    expect(health.lastVisionSample).toContain("No puedo ayudarte");
    expect(health.lastVisionError).toContain("sin el JSON pedido");

    // Y NO se le muestra a cualquiera: puede traer texto del documento.
    expect((await service.health()).lastVisionSample).toBeUndefined();
  });
});

/**
 * CUANDO EL QUE FALLA ES EL PROVEEDOR
 *
 * El fallo llegaba como "el modelo de visión no contestó" y nada más. Pero
 * "no contestó" puede ser la clave sin cuota, la imagen demasiado grande o un
 * parámetro que ese modelo no acepta, y cada una se arregla distinto. El
 * cuerpo del error de Groq dice exactamente cuál es: acá se fija que ese
 * cuerpo llegue hasta arriba en vez de perderse.
 */
describe("AiService cuando Groq devuelve un error", () => {
  const config = {
    get: (name: string) =>
      name === "GROQ_API_KEY" ? "clave-de-prueba" : undefined,
  } as unknown as ConfigService;

  const IMAGEN = "data:image/jpeg;base64,AAAA";
  const JSON_OK = '{"corresponde": true, "legible": true}';

  /** Groq contesta lo que se le indique para cada modelo. */
  function conEstados(
    porModelo: Record<string, { status: number; body: string } | string>,
    porDefecto: { status: number; body: string } | string = JSON_OK,
  ) {
    global.fetch = jest.fn((_url: string, init?: { body?: string }) => {
      const pedido = JSON.parse(init?.body ?? "{}") as { model?: string };
      const respuesta = porModelo[String(pedido.model)] ?? porDefecto;

      if (typeof respuesta !== "string") {
        return Promise.resolve({
          ok: false,
          status: respuesta.status,
          text: () => Promise.resolve(respuesta.body),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ choices: [{ message: { content: respuesta } }] }),
      });
    }) as unknown as typeof fetch;

    return new AiService(config);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("devuelve el código y el cuerpo con los que contestó el proveedor", async () => {
    const service = conEstados(
      {},
      {
        status: 429,
        body: '{"error":{"message":"Rate limit reached for model"}}',
      },
    );

    const answer = await service.visionStructuredDetailed(IMAGEN, "leé esto");

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe("upstream_error");
    expect(answer.upstream?.status).toBe(429);
    expect(answer.upstream?.detail).toContain("Rate limit reached");
  });

  it("corta enseguida si el problema es la clave o la cuota", async () => {
    // A todos los modelos les va a pasar lo mismo: probarlos solo hace esperar.
    const service = conEstados({}, { status: 401, body: "invalid api key" });

    const answer = await service.visionStructuredDetailed(IMAGEN, "leé esto");

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.triedModels).toHaveLength(1);
  });

  it("prueba el siguiente modelo cuando el error puede ser de ese modelo", async () => {
    // Un 400 puede ser el tamaño de la imagen o un parámetro que ese modelo no
    // acepta: cortar en el primero dejaba los de respaldo sin usar.
    const service = conEstados({
      "qwen/qwen3.6-27b": { status: 400, body: "image exceeds size limit" },
    });

    const answer = await service.visionStructuredDetailed(IMAGEN, "leé esto");

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.model).not.toBe("qwen/qwen3.6-27b");
  });

  it("si fallan todos, informa el último error del proveedor", async () => {
    const service = conEstados({}, { status: 400, body: "bad request" });

    const answer = await service.visionStructuredDetailed(IMAGEN, "leé esto");

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.triedModels.length).toBeGreaterThan(1);
    expect(answer.upstream?.detail).toContain("bad request");
  });
});
