import { UserRole } from "@prisma/client";
import {
  ActividadDeLaCuenta,
  CRUCES_PARA_AVISAR,
  CRUCES_PARA_SUSPENDER,
  PUBLICACIONES_POR_DIA,
  PUBLICACIONES_POR_SEMANA,
  RESENAS_POR_DIA,
  RESENAS_POR_SEMANA,
  hayQueSuspender,
  puedePublicar,
  puedeResenar,
  senalesDe,
} from "./limites";
import { esCuentaExenta, exentosDeLaConfiguracion } from "./exentos";

/**
 * LA REPUTACIÓN FABRICADA
 *
 * Es lo único que hace que un desconocido le preste su auto a otro. Si se puede
 * fabricar, todo lo demás da igual: alguien arma dos cuentas, se las alquila
 * entre sí, se deja cinco estrellas, y en un fin de semana tiene un perfil
 * Platino con el que estafar a alguien de verdad.
 *
 * Lo que se prueba acá es la política entera, que es pura: los topes, las
 * señales, y —sobre todo— LAS DOS COSAS QUE NO PUEDE HACER:
 *
 *   · no puede dejar pasar un circuito, y
 *   · no puede cerrarle la cuenta a alguien por algo que tiene explicación.
 *
 * La segunda es la que de verdad cuesta: suspender es cerrarle la puerta a una
 * persona sin escucharla, y a las tres de la mañana no tiene a quién
 * reclamarle.
 */

/** Una cuenta sin nada raro. Cada prueba cambia solo lo suyo. */
const TRANQUILA: ActividadDeLaCuenta = {
  resenasEscritasHoy: 0,
  resenasEscritasEnLaSemana: 0,
  publicacionesHoy: 0,
  publicacionesEnLaSemana: 0,
  cruces: [],
  recibidas: 0,
  recibidasDeLosDosQueMas: 0,
  diasDeAntiguedad: 400,
};
const con = (cambios: Partial<ActividadDeLaCuenta>): ActividadDeLaCuenta => ({
  ...TRANQUILA,
  ...cambios,
});

// ── Los topes ─────────────────────────────────────────────────────────────

describe("el tope de reseñas", () => {
  it("deja escribir mientras no se llegue", () => {
    expect(
      puedeResenar(con({ resenasEscritasHoy: RESENAS_POR_DIA - 1 })).permitido,
    ).toBe(true);
  });

  it("corta en el tope del día, no después", () => {
    const v = puedeResenar(con({ resenasEscritasHoy: RESENAS_POR_DIA }));
    expect(v.permitido).toBe(false);
    expect(v.motivo).toBe("RESENAS_POR_DIA");
    // Importa: el mensaje tiene que poder decir CUÁNDO se puede de nuevo.
    expect(v.horasDeEspera).toBe(24);
  });

  it("y en el de la semana", () => {
    const v = puedeResenar(
      con({ resenasEscritasEnLaSemana: RESENAS_POR_SEMANA }),
    );
    expect(v.motivo).toBe("RESENAS_POR_SEMANA");
    expect(v.horasDeEspera).toBe(24 * 7);
  });

  it("CON LOS DOS TOPES TOCADOS GANA EL DEL DÍA", () => {
    /*
      No es un detalle de implementación: lo único que esta respuesta tiene para
      darle a la persona es cuándo puede volver, y el del día vence mucho antes.
      Decirle "una semana" cuando en realidad son horas es empujarla a pensar
      que perdió la posibilidad de reseñar.
    */
    const v = puedeResenar(
      con({
        resenasEscritasHoy: RESENAS_POR_DIA,
        resenasEscritasEnLaSemana: RESENAS_POR_SEMANA,
      }),
    );
    expect(v.motivo).toBe("RESENAS_POR_DIA");
    expect(v.horasDeEspera).toBe(24);
  });
});

describe("el tope de publicaciones", () => {
  it("corta por día y por semana", () => {
    expect(
      puedePublicar(con({ publicacionesHoy: PUBLICACIONES_POR_DIA })).motivo,
    ).toBe("PUBLICACIONES_POR_DIA");
    expect(
      puedePublicar(con({ publicacionesEnLaSemana: PUBLICACIONES_POR_SEMANA }))
        .motivo,
    ).toBe("PUBLICACIONES_POR_SEMANA");
  });

  it("y deja publicar normalmente", () => {
    expect(
      puedePublicar(con({ publicacionesHoy: 1, publicacionesEnLaSemana: 3 }))
        .permitido,
    ).toBe(true);
  });
});

// ── Las señales ───────────────────────────────────────────────────────────

describe("el anillo de reseñas", () => {
  /** Dos cuentas que se reseñan entre sí `veces` veces cada una. */
  const circuito = (veces: number) =>
    con({
      cruces: [{ otroId: "otra-cuenta", escritas: veces, recibidas: veces }],
    });

  it("SUSPENDE SOLO cuando el ida y vuelta no tiene explicación", () => {
    const senales = senalesDe(circuito(CRUCES_PARA_SUSPENDER));
    expect(senales[0].tipo).toBe("ANILLO_DE_RESENAS");
    expect(senales[0].suspende).toBe(true);
    expect(hayQueSuspender(senales)).toBe(true);
    // Los números viajan con la señal: quien la mire no tiene que ir a buscarlos.
    expect(senales[0].detalle).toMatchObject({
      conLaCuenta: "otra-cuenta",
      leEscribio: CRUCES_PARA_SUSPENDER,
      recibioDeElla: CRUCES_PARA_SUSPENDER,
    });
  });

  it("DOS AMIGOS QUE SE PRESTAN EL AUTO AVISAN, PERO NO SE SUSPENDEN", () => {
    /*
      La prueba que importa de todo el archivo. Dos conocidos que se alquilan
      el auto un par de veces producen exactamente la misma forma que un
      circuito, en chico. Suspenderlos por eso sería el peor error posible: el
      sistema castigando a quien lo usa bien.
    */
    const senales = senalesDe(circuito(CRUCES_PARA_AVISAR));
    expect(senales[0].tipo).toBe("RESENAS_CRUZADAS");
    expect(senales[0].suspende).toBe(false);
    expect(hayQueSuspender(senales)).toBe(false);
  });

  it("una sola vez con alguien no dice nada", () => {
    expect(senalesDe(circuito(1))).toEqual([]);
  });

  it("MUCHAS RESEÑAS EN UNA SOLA DIRECCIÓN NO SON UN ANILLO", () => {
    /*
      Alguien que alquila todos los meses el mismo auto le escribe diez reseñas
      al mismo dueño y no recibe ninguna de vuelta. Eso es un cliente fiel, no
      un circuito: lo que define al circuito es que vaya en las DOS
      direcciones. Si esto se contara sumando, el cliente fiel sería el primer
      suspendido.
    */
    const senales = senalesDe(
      con({ cruces: [{ otroId: "un-dueño", escritas: 10, recibidas: 0 }] }),
    );
    expect(senales).toEqual([]);
  });

  it("y el que recibe muchas de alguien sin devolverle ninguna, tampoco", () => {
    const senales = senalesDe(
      con({ cruces: [{ otroId: "un-inquilino", escritas: 0, recibidas: 9 }] }),
    );
    expect(hayQueSuspender(senales)).toBe(false);
  });

  it("mira el cruce MÁS FUERTE, no el primero de la lista", () => {
    const senales = senalesDe(
      con({
        cruces: [
          { otroId: "normal", escritas: 1, recibidas: 1 },
          { otroId: "el-circuito", escritas: 5, recibidas: 5 },
          { otroId: "otro", escritas: 0, recibidas: 2 },
        ],
      }),
    );
    expect(senales[0].tipo).toBe("ANILLO_DE_RESENAS");
    expect(senales[0].detalle).toMatchObject({ conLaCuenta: "el-circuito" });
  });
});

describe("de dónde vienen las reseñas", () => {
  it("avisa cuando casi todas vienen de dos cuentas", () => {
    const senales = senalesDe(
      con({ recibidas: 10, recibidasDeLosDosQueMas: 9 }),
    );
    expect(senales.map((s) => s.tipo)).toContain("RESENAS_CONCENTRADAS");
    expect(senales.every((s) => !s.suspende)).toBe(true);
  });

  it("y no cuando están repartidas", () => {
    expect(
      senalesDe(con({ recibidas: 10, recibidasDeLosDosQueMas: 4 })),
    ).toEqual([]);
  });

  it("CON POCAS RESEÑAS NO MIRA NADA", () => {
    // Con tres reseñas, que las tres vengan de la misma persona no significa
    // nada: es una cuenta nueva. El patrón necesita volumen para existir.
    expect(
      senalesDe(con({ recibidas: 3, recibidasDeLosDosQueMas: 3 })),
    ).toEqual([]);
  });
});

describe("la cuenta demasiado rápida", () => {
  it("avisa de una cuenta nueva con mucha reputación encima", () => {
    const senales = senalesDe(
      con({ diasDeAntiguedad: 2, recibidas: 8, recibidasDeLosDosQueMas: 4 }),
    );
    expect(senales.map((s) => s.tipo)).toContain("REPUTACION_DEMASIADO_RAPIDA");
    expect(hayQueSuspender(senales)).toBe(false);
  });

  it("y no de una cuenta vieja con las mismas reseñas", () => {
    const senales = senalesDe(
      con({ diasDeAntiguedad: 300, recibidas: 8, recibidasDeLosDosQueMas: 4 }),
    );
    expect(senales.map((s) => s.tipo)).not.toContain(
      "REPUTACION_DEMASIADO_RAPIDA",
    );
  });
});

describe("publicar en ráfaga", () => {
  it("avisa", () => {
    const senales = senalesDe(con({ publicacionesHoy: PUBLICACIONES_POR_DIA }));
    expect(senales.map((s) => s.tipo)).toContain("PUBLICACIONES_EN_RAFAGA");
  });

  it("PERO NO SUSPENDE NUNCA, por más autos que sean", () => {
    /*
      Publicar veinte autos es raro, no es fraude: puede ser una agencia chica
      cargando su flota. Lo que corresponde es pedirle que demuestre que los
      autos son suyos, y eso no lo decide un `if`. Por eso publicar tiene tope
      —la velocidad se limita— y avisa, pero jamás cierra una cuenta.
    */
    const senales = senalesDe(
      con({ publicacionesHoy: 50, publicacionesEnLaSemana: 200 }),
    );
    expect(senales.length).toBeGreaterThan(0);
    expect(hayQueSuspender(senales)).toBe(false);
  });
});

describe("varias señales a la vez", () => {
  it("se devuelven TODAS, no la primera", () => {
    // Dos señales sobre la misma cuenta son un dato más fuerte que cualquiera
    // de las dos, y quien mire el panel tiene que verlas juntas.
    const senales = senalesDe(
      con({
        cruces: [{ otroId: "x", escritas: 2, recibidas: 2 }],
        recibidas: 10,
        recibidasDeLosDosQueMas: 9,
        diasDeAntiguedad: 3,
        publicacionesHoy: PUBLICACIONES_POR_DIA,
      }),
    );
    expect(senales.map((s) => s.tipo).sort()).toEqual([
      "PUBLICACIONES_EN_RAFAGA",
      "REPUTACION_DEMASIADO_RAPIDA",
      "RESENAS_CONCENTRADAS",
      "RESENAS_CRUZADAS",
    ]);
  });

  it("una cuenta tranquila no enciende ninguna", () => {
    expect(senalesDe(TRANQUILA)).toEqual([]);
    expect(
      senalesDe(
        con({
          resenasEscritasEnLaSemana: 3,
          publicacionesEnLaSemana: 2,
          recibidas: 20,
          recibidasDeLosDosQueMas: 5,
          cruces: [{ otroId: "a", escritas: 1, recibidas: 1 }],
        }),
      ),
    ).toEqual([]);
  });
});

// ── Las excepciones ───────────────────────────────────────────────────────

describe("las cuentas exentas", () => {
  /*
    Una lista de excepciones a un control de seguridad es la primera puerta que
    busca alguien que entró. Por eso son tres casos cerrados y no una condición
    general, y por eso se prueban uno por uno.
  */
  it("la cuenta administradora, porque prueba el sistema", () => {
    expect(esCuentaExenta({ email: "a@b.com", role: UserRole.ADMIN })).toBe(
      true,
    );
  });

  it("las cuentas sembradas de demostración", () => {
    // El historial que carga el deploy arma alquileres cruzados entre las
    // mismas cuentas: en los números es un anillo perfecto. Lo es porque son
    // datos sembrados, no conducta.
    expect(
      esCuentaExenta({ email: "demo03@freewheel.demo", role: UserRole.USER }),
    ).toBe(true);
  });

  it("y las que diga la configuración, sin importar mayúsculas ni espacios", () => {
    const extras = exentosDeLaConfiguracion(" Una@Cuenta.com , otra@x.com ,, ");
    expect(extras).toEqual(["una@cuenta.com", "otra@x.com"]);
    expect(
      esCuentaExenta({ email: "UNA@cuenta.COM", role: UserRole.USER }, extras),
    ).toBe(true);
  });

  it("NADIE MÁS", () => {
    expect(
      esCuentaExenta({ email: "cualquiera@gmail.com", role: UserRole.USER }),
    ).toBe(false);
    // Un dominio parecido no alcanza: tiene que terminar exactamente así.
    expect(
      esCuentaExenta({ email: "x@freewheel.demo.ar", role: UserRole.USER }),
    ).toBe(false);
    expect(
      esCuentaExenta({ email: "x@freewheel.demox", role: UserRole.USER }),
    ).toBe(false);
    expect(esCuentaExenta(null)).toBe(false);
    expect(esCuentaExenta(undefined)).toBe(false);
  });

  it("y una lista vacía no exime a nadie", () => {
    expect(exentosDeLaConfiguracion(undefined)).toEqual([]);
    expect(exentosDeLaConfiguracion("")).toEqual([]);
    expect(esCuentaExenta({ email: "x@y.com", role: UserRole.USER }, [])).toBe(
      false,
    );
  });
});
