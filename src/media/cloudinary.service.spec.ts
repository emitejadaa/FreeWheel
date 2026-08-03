import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "crypto";
import { CloudinaryService } from "./cloudinary.service";

function makeService(
  env: Record<string, string | undefined> = {
    CLOUDINARY_CLOUD_NAME: "demo-cloud",
    CLOUDINARY_API_KEY: "key123",
    CLOUDINARY_API_SECRET: "secret456",
  },
): CloudinaryService {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new CloudinaryService(config);
}

describe("CloudinaryService", () => {
  it("throws 503 when the credentials are missing", () => {
    const service = makeService({});
    expect(() => service.getCloudName()).toThrow(ServiceUnavailableException);
    expect(() => service.signUploadParams({ folder: "x" })).toThrow(
      ServiceUnavailableException,
    );
  });

  it("signs upload params sorted alphabetically with the secret appended", () => {
    const service = makeService();
    const params = {
      timestamp: 1700000000,
      folder: "identity/user-1",
      public_id: "dni_front_1_abcdef01",
      type: "authenticated",
    };
    const { cloudName, apiKey, signature } = service.signUploadParams(params);

    const expected = createHash("sha1")
      .update(
        "folder=identity/user-1&public_id=dni_front_1_abcdef01" +
          "&timestamp=1700000000&type=authenticated" +
          "secret456",
      )
      .digest("hex");
    expect(cloudName).toBe("demo-cloud");
    expect(apiKey).toBe("key123");
    expect(signature).toBe(expected);
  });

  it("omits empty params from the signature base", () => {
    const service = makeService();
    const withEmpty = service.signUploadParams({
      folder: "f",
      timestamp: 1,
      type: "",
    });
    const without = service.signUploadParams({ folder: "f", timestamp: 1 });
    expect(withEmpty.signature).toBe(without.signature);
  });

  it("builds a signed authenticated delivery URL (s--sig-- segment)", () => {
    const service = makeService();
    const url = service.signedDeliveryUrl("identity/user-1/dni_front_1_ab", {
      format: "jpg",
    });

    const path = "identity/user-1/dni_front_1_ab.jpg";
    const sig = createHash("sha1")
      .update(path + "secret456")
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .slice(0, 8);
    expect(url).toBe(
      `https://res.cloudinary.com/demo-cloud/image/authenticated/s--${sig}--/${path}`,
    );
  });

  it("prepends the transformation to the signed path", () => {
    const service = makeService();
    const url = service.signedDeliveryUrl("identity/u/doc", {
      transformation: "w_2000",
      format: "jpg",
    });
    expect(url).toContain("/w_2000/identity/u/doc.jpg");
  });

  it("resourceExists maps 404 to false, ok to true, and errors to 503", async () => {
    const service = makeService();
    const fetchMock = jest.spyOn(global, "fetch" as never);

    fetchMock.mockResolvedValueOnce({ status: 404, ok: false } as never);
    await expect(service.resourceExists("identity/u/a")).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce({ status: 200, ok: true } as never);
    await expect(service.resourceExists("identity/u/a")).resolves.toBe(true);

    fetchMock.mockResolvedValueOnce({ status: 401, ok: false } as never);
    await expect(service.resourceExists("identity/u/a")).rejects.toThrow(
      ServiceUnavailableException,
    );

    fetchMock.mockRestore();
  });
});
