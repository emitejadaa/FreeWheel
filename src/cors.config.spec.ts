import { createCorsOptions } from "./cors.config";

/**
 * Quién puede llamar a la API desde un navegador.
 *
 * HOY está abierto a cualquiera, a propósito, mientras se prueba la
 * verificación de documentos desde un HTML suelto. La lista blanca sigue
 * existiendo y se enciende con CORS_STRICT="true"; estas pruebas fijan las dos
 * cosas: que sin la variable no rebote nada, y que con ella la lista funcione
 * exactamente como antes. Lo segundo importa porque el día que esto se cierre,
 * un `origin` de más no se ve en ninguna pantalla: se nota cuando alguien usa
 * las rutas públicas —el chatbot, que gasta cuota de nuestra API key— desde el
 * navegador de los visitantes de otro sitio.
 */
describe("CORS", () => {
  const ORIGINALES = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINALES };
  });

  /** Pregunta por un origen y devuelve si quedó permitido. */
  function permite(origen: string | undefined): boolean {
    const opciones = createCorsOptions();
    const decidir = opciones.origin as (
      origen: string | undefined,
      callback: (error: Error | null, permitido?: boolean) => void,
    ) => void;

    let resultado: boolean | undefined;
    let error: Error | null = null;
    decidir(origen, (err, permitido) => {
      error = err;
      resultado = permitido;
    });

    // Nunca por excepción: un origen no permitido tiene que quedarse sin
    // cabeceras CORS, no recibir un 500.
    expect(error).toBeNull();
    return resultado === true;
  }

  describe("con CORS_STRICT y sin CORS_ORIGINS", () => {
    beforeEach(() => {
      process.env.CORS_STRICT = "true";
      process.env.CORS_ORIGINS = "";
      process.env.FRONTEND_URL = "https://freewheel-5a.vercel.app";
    });

    it("permite el front de producción", () => {
      expect(permite("https://freewheel-5a.vercel.app")).toBe(true);
    });

    it("permite el mismo origen con barra al final", () => {
      expect(permite("https://freewheel-5a.vercel.app/")).toBe(true);
    });

    it("permite los puertos de desarrollo", () => {
      expect(permite("http://localhost:5173")).toBe(true);
      expect(permite("http://localhost:4173")).toBe(true);
    });

    it("permite un deploy de vista previa de Vercel", () => {
      expect(permite("https://fw-git-rama-brito.vercel.app")).toBe(true);
    });

    it("rechaza cualquier otro sitio", () => {
      expect(permite("https://sitio-cualquiera.com")).toBe(false);
      expect(permite("http://localhost:9999")).toBe(false);
    });

    it("no se deja engañar por un dominio que TERMINA en el nuestro", () => {
      // El clásico: vercel.app.atacante.com contiene el texto pero no es Vercel.
      expect(permite("https://fw.vercel.app.atacante.com")).toBe(false);
      expect(permite("https://freewheel-5a.vercel.app.evil.com")).toBe(false);
    });

    it("deja pasar un pedido sin Origin (curl, Postman, el webhook)", () => {
      // CORS lo hace cumplir el navegador: bloquear acá no suma seguridad y sí
      // rompe las integraciones que no son un navegador.
      expect(permite(undefined)).toBe(true);
    });
  });

  describe("con CORS_STRICT y CORS_ORIGINS cargada", () => {
    beforeEach(() => {
      process.env.CORS_STRICT = "true";
      process.env.CORS_ORIGINS =
        "https://freewheel.com.ar, https://www.freewheel.com.ar";
      process.env.FRONTEND_URL = "https://freewheel-5a.vercel.app";
    });

    it("permite solo lo que dice la variable", () => {
      expect(permite("https://freewheel.com.ar")).toBe(true);
      expect(permite("https://www.freewheel.com.ar")).toBe(true);
    });

    it("ya no permite las vistas previas ni localhost", () => {
      expect(permite("https://fw-git-rama-brito.vercel.app")).toBe(false);
      expect(permite("http://localhost:5173")).toBe(false);
    });

    it("tampoco permite el FRONTEND_URL si no está en la lista", () => {
      // Es a propósito: si alguien se toma el trabajo de escribir la lista, la
      // lista manda. Media configuración es la que sorprende.
      expect(permite("https://freewheel-5a.vercel.app")).toBe(false);
    });
  });
});

/**
 * DEMO_ORIGINS existe para poder abrir el front de prueba de la verificación
 * de documentos —un HTML suelto servido en localhost— contra el backend
 * desplegado, sin tener que meter mano en la lista de producción. Se suma
 * también en modo estricto justamente porque en producción CORS_ORIGINS está
 * cargada y si no, no habría forma de probar nada.
 */
describe("createCorsOptions con DEMO_ORIGINS", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  function permite(origen: string): boolean {
    const { origin } = createCorsOptions();
    let permitido = false;
    (
      origin as (
        o: string | undefined,
        cb: (e: unknown, ok?: boolean) => void,
      ) => void
    )(origen, (_error, ok) => {
      permitido = ok === true;
    });
    return permitido;
  }

  it("se suma a la lista estricta de producción", () => {
    process.env.CORS_STRICT = "true";
    process.env.CORS_ORIGINS = "https://freewheel.app";
    process.env.DEMO_ORIGINS = "http://localhost:8080";

    expect(permite("https://freewheel.app")).toBe(true);
    expect(permite("http://localhost:8080")).toBe(true);
    expect(permite("http://localhost:9999")).toBe(false);
  });

  it("acepta varios separados por coma", () => {
    process.env.CORS_STRICT = "true";
    process.env.CORS_ORIGINS = "https://freewheel.app";
    process.env.DEMO_ORIGINS = "http://localhost:8080, http://127.0.0.1:8080";

    expect(permite("http://127.0.0.1:8080")).toBe(true);
  });

  it("sin la variable, no cambia nada", () => {
    process.env.CORS_STRICT = "true";
    process.env.CORS_ORIGINS = "https://freewheel.app";
    delete process.env.DEMO_ORIGINS;

    expect(permite("http://localhost:8080")).toBe(false);
  });

  it("el puerto del front de prueba ya está en los orígenes de desarrollo", () => {
    process.env.CORS_STRICT = "true";
    delete process.env.CORS_ORIGINS;
    delete process.env.DEMO_ORIGINS;

    expect(permite("http://localhost:8080")).toBe(true);
  });
});

/**
 * EL MODO DE HOY: ABIERTO
 *
 * Se abrió a propósito para poder probar la verificación de documentos desde
 * un HTML suelto sin tener que cargar una variable y redeployar cada vez que
 * cambia el puerto. Estas pruebas fijan que sea EFECTIVAMENTE abierto —que no
 * quede ninguna combinación de variables que lo cierre por accidente— y que
 * `credentials` siga reflejando el origen en vez de mandar un "*" literal,
 * que el propio navegador rechaza.
 */
describe("CORS abierto (sin CORS_STRICT)", () => {
  const ORIGINALES = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINALES };
  });

  function permite(origen: string | undefined): boolean {
    const decidir = createCorsOptions().origin as (
      origen: string | undefined,
      callback: (error: Error | null, permitido?: boolean) => void,
    ) => void;
    let resultado: boolean | undefined;
    decidir(origen, (_error, permitido) => {
      resultado = permitido;
    });
    return resultado === true;
  }

  beforeEach(() => {
    delete process.env.CORS_STRICT;
  });

  it("permite cualquier sitio", () => {
    expect(permite("https://freewheel.com.ar")).toBe(true);
    expect(permite("http://localhost:9999")).toBe(true);
    expect(permite("https://un-sitio-cualquiera.example")).toBe(true);
    expect(permite("null")).toBe(true);
  });

  it("permite igual sin cabecera Origin (curl, Postman, webhooks)", () => {
    expect(permite(undefined)).toBe(true);
  });

  it("CORS_ORIGINS cargada ya no cierra nada por su cuenta", () => {
    // Es el caso que trababa: la variable estaba puesta en el deploy y
    // convertía la lista en la única permitida, sin que nadie lo pidiera.
    process.env.CORS_ORIGINS = "https://freewheel.com.ar";
    expect(permite("http://localhost:8080")).toBe(true);
  });

  it("no manda un asterisco: con credentials el navegador lo rechazaría", () => {
    const opciones = createCorsOptions();
    expect(opciones.credentials).toBe(true);
    expect(opciones.origin).toBeInstanceOf(Function);
  });

  it('CORS_STRICT="true" devuelve la lista blanca', () => {
    process.env.CORS_STRICT = "true";
    process.env.CORS_ORIGINS = "https://freewheel.com.ar";

    expect(permite("https://freewheel.com.ar")).toBe(true);
    expect(permite("https://un-sitio-cualquiera.example")).toBe(false);
  });

  it("cualquier otro valor de CORS_STRICT no cierra nada", () => {
    // Que un "1" o un "yes" cierren la API sin querer sería peor que abrirla.
    for (const valor of ["1", "yes", "TRUE ", "false", ""]) {
      process.env.CORS_STRICT = valor;
      const cerrado = !permite("https://un-sitio-cualquiera.example");
      expect(cerrado).toBe(valor.trim().toLowerCase() === "true");
    }
  });
});
