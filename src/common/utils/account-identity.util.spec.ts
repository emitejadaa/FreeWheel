import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  identityConflict,
  identityConflictFromPrisma,
} from "./account-identity.util";

/** El P2002 tal como lo tira Prisma cuando choca un índice único. */
function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

const codeOf = (error: ConflictException | null) =>
  (error?.getResponse() as { code?: string } | undefined)?.code;

describe("identityConflict", () => {
  it("dice QUÉ dato está repetido, no solo que hubo un choque", () => {
    expect(codeOf(identityConflict("email"))).toBe("EMAIL_ALREADY_REGISTERED");
    expect(codeOf(identityConflict("phone"))).toBe("PHONE_ALREADY_REGISTERED");
    expect(codeOf(identityConflict("dni"))).toBe("DNI_ALREADY_REGISTERED");
  });
});

describe("identityConflictFromPrisma", () => {
  it("traduce el choque venga como lista de columnas...", () => {
    expect(codeOf(identityConflictFromPrisma(p2002(["email"])))).toBe(
      "EMAIL_ALREADY_REGISTERED",
    );
    expect(codeOf(identityConflictFromPrisma(p2002(["phone"])))).toBe(
      "PHONE_ALREADY_REGISTERED",
    );
  });

  it("...o como el nombre del índice, que es lo que manda Postgres", () => {
    // Los nombres reales de los índices de User, incluido el que Prisma no sabe
    // expresar y crea prisma/premigrate/003_account_identity_unique.sql.
    const casos: [string, string][] = [
      ["User_email_key", "EMAIL_ALREADY_REGISTERED"],
      ["User_email_lower_key", "EMAIL_ALREADY_REGISTERED"],
      ["User_phone_key", "PHONE_ALREADY_REGISTERED"],
      ["User_dni_key", "DNI_ALREADY_REGISTERED"],
      ["User_cuil_key", "CUIL_ALREADY_REGISTERED"],
      ["User_googleId_key", "GOOGLE_ACCOUNT_ALREADY_LINKED"],
    ];
    for (const [indice, code] of casos) {
      expect(codeOf(identityConflictFromPrisma(p2002(indice)))).toBe(code);
    }
  });

  it("no se confunde entre campos con nombres parecidos", () => {
    // "User_cuil_key" no contiene "email"; "User_dni_key" no contiene "phone".
    expect(codeOf(identityConflictFromPrisma(p2002("User_cuil_key")))).toBe(
      "CUIL_ALREADY_REGISTERED",
    );
    expect(codeOf(identityConflictFromPrisma(p2002("User_dni_key")))).toBe(
      "DNI_ALREADY_REGISTERED",
    );
  });

  it("devuelve null si el choque es de un índice que no es de identidad", () => {
    expect(
      identityConflictFromPrisma(p2002(["listingId", "userId"])),
    ).toBeNull();
    expect(identityConflictFromPrisma(p2002(undefined))).toBeNull();
  });

  it("devuelve null si el error no es un P2002, para volver a lanzarlo tal cual", () => {
    expect(identityConflictFromPrisma(new Error("boom"))).toBeNull();
    expect(
      identityConflictFromPrisma(
        new Prisma.PrismaClientKnownRequestError("not found", {
          code: "P2025",
          clientVersion: "test",
        }),
      ),
    ).toBeNull();
  });
});
