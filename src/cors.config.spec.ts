import { createCorsOptions, parseCorsOrigins } from "./cors.config";

describe("CORS config", () => {
  it("parses frontend and comma-separated origins without duplicates or trailing slashes", () => {
    expect(
      parseCorsOrigins({
        NODE_ENV: "production",
        FRONTEND_URL: "https://freewheel-5a.vercel.app/",
        CORS_ORIGINS:
          "https://preview-a.vercel.app, https://preview-b.vercel.app/",
      }),
    ).toEqual([
      "https://freewheel-5a.vercel.app",
      "https://preview-a.vercel.app",
      "https://preview-b.vercel.app",
    ]);
  });

  it("reflects any origin so deployed frontends do not break on CORS", () => {
    const options = createCorsOptions(["https://freewheel-5a.vercel.app"]);

    expect(options.origin).toBe(true);
    expect(options.credentials).toBe(true);
    expect(options.methods).toContain("OPTIONS");
    expect(options.allowedHeaders).toBeUndefined();
  });
});
