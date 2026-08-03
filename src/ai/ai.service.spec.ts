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
});
