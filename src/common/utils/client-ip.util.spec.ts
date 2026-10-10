import { clientIp, ipRateLimitKey } from "./client-ip.util";

describe("clientIp", () => {
  const VERCEL = process.env.VERCEL;
  afterEach(() => {
    if (VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = VERCEL;
  });

  it("una IPv4 vista por un socket dual se guarda como la IPv4 que es", () => {
    // Según cómo escuche el servidor, Node da "::ffff:1.2.3.4" o "1.2.3.4"
    // para la misma conexión: lo guardado no puede depender de eso.
    expect(clientIp({ ip: "::ffff:127.0.0.1" })).toBe("127.0.0.1");
    expect(clientIp({ ip: "127.0.0.1" })).toBe("127.0.0.1");
    expect(clientIp({ socket: { remoteAddress: "::FFFF:10.0.0.5" } })).toBe(
      "10.0.0.5",
    );
  });

  it("sin un proxy de confianza, X-Forwarded-For no se cree", () => {
    delete process.env.VERCEL;
    expect(
      clientIp({ ip: "10.0.0.5", headers: { "x-forwarded-for": "1.2.3.4" } }),
    ).toBe("10.0.0.5");
  });

  it("detrás de Vercel manda su cabecera", () => {
    process.env.VERCEL = "1";
    expect(
      clientIp({
        ip: "10.0.0.5",
        headers: { "x-vercel-forwarded-for": "203.0.113.7, 10.0.0.1" },
      }),
    ).toBe("203.0.113.7");
  });
});

describe("ipRateLimitKey", () => {
  it("cuenta una IPv6 por su /64: cambiar de dirección no da un contador nuevo", () => {
    expect(ipRateLimitKey("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(ipRateLimitKey("2001:db8:abcd:12:ffff:1:2:3")).toBe(
      "2001:db8:abcd:12::/64",
    );
  });

  it("una IPv4 escrita como IPv6 cuenta como la misma IPv4", () => {
    expect(ipRateLimitKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(ipRateLimitKey("1.2.3.4")).toBe("1.2.3.4");
  });

  it("sin IP, un contador común en vez de ninguno", () => {
    expect(ipRateLimitKey(null)).toBe("unknown");
  });
});
