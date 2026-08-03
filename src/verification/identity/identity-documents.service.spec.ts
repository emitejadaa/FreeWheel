import { BadRequestException } from "@nestjs/common";
import { UserVerification, VerificationStatus } from "@prisma/client";
import { CloudinaryService } from "../../media/cloudinary.service";
import { SubmitIdentityDto } from "../dto/submit-identity.dto";
import { IdentityDocumentsService } from "./identity-documents.service";

const CLOUD = "test-cloud";
const USER = "user-1";

function makeService(exists = true) {
  const signUploadParams = jest.fn(() => ({
    cloudName: CLOUD,
    apiKey: "key",
    signature: "sig",
  }));
  const cloudinary = {
    getCloudName: () => CLOUD,
    signUploadParams,
    resourceExists: jest.fn().mockResolvedValue(exists),
  } as unknown as CloudinaryService;

  return {
    service: new IdentityDocumentsService(cloudinary),
    signUploadParams,
  };
}

function url(publicId: string, cloud = CLOUD, format = "jpg"): string {
  return `https://res.cloudinary.com/${cloud}/image/authenticated/${publicId}.${format}`;
}

function docs(overrides: Partial<SubmitIdentityDto> = {}): SubmitIdentityDto {
  return {
    dniFrontUrl: url(`identity/${USER}/dni_front_1_aaaa`),
    dniBackUrl: url(`identity/${USER}/dni_back_1_bbbb`),
    licenseFrontUrl: url(`identity/${USER}/license_front_1_cccc`),
    licenseBackUrl: url(`identity/${USER}/license_back_1_dddd`),
    ...overrides,
  } as SubmitIdentityDto;
}

describe("IdentityDocumentsService.signUpload", () => {
  it("forces folder, slot-prefixed public_id and authenticated delivery", () => {
    const { service, signUploadParams } = makeService();
    const result = service.signUpload(USER, { document: "dni", side: "back" });

    expect(result.folder).toBe(`identity/${USER}`);
    expect(result.publicId).toMatch(
      new RegExp(`^identity/${USER}/dni_back_\\d+_[0-9a-f]{8}$`),
    );
    expect(result.type).toBe("authenticated");
    expect(signUploadParams).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: `identity/${USER}`,
        public_id: result.publicId,
        type: "authenticated",
      }),
    );
  });

  it("never collides between two signatures for the same slot", () => {
    const { service } = makeService();
    const a = service.signUpload(USER, { document: "license", side: "front" });
    const b = service.signUpload(USER, { document: "license", side: "front" });
    expect(a.publicId).not.toBe(b.publicId);
  });
});

describe("IdentityDocumentsService.validateSubmission", () => {
  it("accepts our own authenticated URLs and returns canonical ones", async () => {
    const { service } = makeService();
    // Tal cual lo devuelve Cloudinary tras subir: con firma y versión.
    const signed =
      `https://res.cloudinary.com/${CLOUD}/image/authenticated` +
      `/s--AbCd1234--/v1700000000/identity/${USER}/dni_front_1_aaaa.jpg`;

    const result = await service.validateSubmission(
      USER,
      docs({ dniFrontUrl: signed }),
    );

    // La firma y la versión se descartan al persistir.
    expect(result.dniFrontUrl).toBe(url(`identity/${USER}/dni_front_1_aaaa`));
    expect(result.licenseBackUrl).toBe(
      url(`identity/${USER}/license_back_1_dddd`),
    );
  });

  it("rejects a URL from another cloud (INVALID_DOCUMENT_URL)", async () => {
    const { service } = makeService();
    await expect(
      service.validateSubmission(
        USER,
        docs({
          dniFrontUrl: url(`identity/${USER}/dni_front_1_aaaa`, "evil-cloud"),
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: "INVALID_DOCUMENT_URL", slot: "dni_front" },
    });
  });

  it("rejects a plain external URL", async () => {
    const { service } = makeService();
    await expect(
      service.validateSubmission(
        USER,
        docs({ dniBackUrl: "https://example.com/dni-back.png" }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a public (non-authenticated) delivery URL", async () => {
    const { service } = makeService();
    await expect(
      service.validateSubmission(
        USER,
        docs({
          dniFrontUrl: `https://res.cloudinary.com/${CLOUD}/image/upload/identity/${USER}/dni_front_1_aaaa.jpg`,
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: "INVALID_DOCUMENT_URL" },
    });
  });

  it("rejects a file uploaded for another slot (DOCUMENT_SLOT_MISMATCH)", async () => {
    const { service } = makeService();
    await expect(
      service.validateSubmission(
        USER,
        // El dorso de la licencia enviado como frente del DNI.
        docs({ dniFrontUrl: url(`identity/${USER}/license_back_1_dddd`) }),
      ),
    ).rejects.toMatchObject({
      response: { code: "DOCUMENT_SLOT_MISMATCH", slot: "dni_front" },
    });
  });

  it("rejects a file belonging to another user", async () => {
    const { service } = makeService();
    await expect(
      service.validateSubmission(
        USER,
        docs({ dniFrontUrl: url("identity/otro-user/dni_front_1_aaaa") }),
      ),
    ).rejects.toMatchObject({
      response: { code: "DOCUMENT_SLOT_MISMATCH" },
    });
  });

  it("rejects a format that is not an image", async () => {
    const { service } = makeService();
    await expect(
      service.validateSubmission(
        USER,
        docs({
          dniFrontUrl: url(`identity/${USER}/dni_front_1_aaaa`, CLOUD, "pdf"),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "INVALID_DOCUMENT_URL" } });
  });

  it("rejects when the asset does not exist in Cloudinary", async () => {
    const { service } = makeService(false);
    await expect(
      service.validateSubmission(USER, docs()),
    ).rejects.toMatchObject({ response: { code: "DOCUMENT_NOT_FOUND" } });
  });
});

describe("IdentityDocumentsService.toPublicView", () => {
  it("exposes presence flags and reason codes but never URLs or notes", () => {
    const { service } = makeService();
    const submission = {
      id: "ver-1",
      userId: USER,
      status: VerificationStatus.REJECTED,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      reviewedAt: new Date("2026-01-02T00:00:00.000Z"),
      dniFrontUrl: url(`identity/${USER}/dni_front_1_aaaa`),
      dniBackUrl: url(`identity/${USER}/dni_back_1_bbbb`),
      licenseFrontUrl: url(`identity/${USER}/license_front_1_cccc`),
      licenseBackUrl: null,
      notes: "interno: no mostrar",
      matchReport: { reasonCodes: ["DOB_MISMATCH", 42] },
      extracted: { ocr: { nombre: "JUAN" } },
    } as unknown as UserVerification;

    const view = service.toPublicView(submission);

    expect(view).toEqual({
      id: "ver-1",
      status: VerificationStatus.REJECTED,
      createdAt: submission.createdAt,
      reviewedAt: submission.reviewedAt,
      reasonCodes: ["DOB_MISMATCH"],
      documents: {
        dniFront: true,
        dniBack: true,
        licenseFront: true,
        licenseBack: false,
      },
    });
    expect(JSON.stringify(view)).not.toContain("cloudinary");
    expect(JSON.stringify(view)).not.toContain("interno");
    expect(JSON.stringify(view)).not.toContain("JUAN");
  });

  it("tolerates a submission with no match report", () => {
    const { service } = makeService();
    const view = service.toPublicView({
      id: "ver-2",
      status: VerificationStatus.ID_SUBMITTED,
      createdAt: new Date(),
      reviewedAt: null,
      matchReport: null,
    } as unknown as UserVerification);
    expect(view.reasonCodes).toEqual([]);
  });
});
