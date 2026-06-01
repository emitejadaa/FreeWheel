import { createCorsOptions } from "./cors.config";

describe("CORS config", () => {
  it("reflects any origin so deployed frontends do not break on CORS", () => {
    const options = createCorsOptions();

    expect(options.origin).toBe(true);
    expect(options.credentials).toBe(true);
    expect(options.methods).toContain("OPTIONS");
    expect(options.allowedHeaders).toBeUndefined();
  });
});
