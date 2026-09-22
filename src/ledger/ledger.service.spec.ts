import { LedgerService } from "./ledger.service";
import { Accounts } from "./accounts";

/**
 * La prueba que importa es la negativa: un asiento que no cierra no se
 * escribe NUNCA. Es plata que aparece o desaparece, que es lo que la partida
 * doble existe para impedir.
 */
function crear() {
  const creados: unknown[] = [];
  const prisma = {
    ledgerJournal: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((args: unknown) => {
        creados.push(args);
        return Promise.resolve({ id: "j1" });
      }),
    },
  };
  return { service: new LedgerService(prisma as never), prisma, creados };
}

const base = {
  idempotencyKey: "k1",
  type: "test",
  description: "prueba",
  currency: "usd",
};

describe("LedgerService.post", () => {
  it("asienta un movimiento que cierra en cero", async () => {
    const { service, creados } = crear();
    const r = await service.post({
      ...base,
      lines: [
        { account: Accounts.processorClearing(), amountMinor: -1000 },
        { account: Accounts.bookingSena("b1"), amountMinor: 1000 },
      ],
    });
    expect(r).toEqual({ journalId: "j1", duplicate: false });
    expect(creados).toHaveLength(1);
  });

  it("rechaza un asiento que no cierra", async () => {
    const { service, creados } = crear();
    await expect(
      service.post({
        ...base,
        lines: [
          { account: Accounts.processorClearing(), amountMinor: -1000 },
          { account: Accounts.bookingSena("b1"), amountMinor: 999 },
        ],
      }),
    ).rejects.toMatchObject({
      response: { code: "LEDGER_JOURNAL_UNBALANCED" },
    });
    expect(creados).toHaveLength(0);
  });

  it("rechaza montos con decimales", async () => {
    const { service } = crear();
    await expect(
      service.post({
        ...base,
        lines: [
          { account: "a:x", amountMinor: -10.5 },
          { account: "b:x", amountMinor: 10.5 },
        ],
      }),
    ).rejects.toMatchObject({
      response: { code: "LEDGER_AMOUNT_NOT_INTEGER" },
    });
  });

  it("el mismo hecho asentado dos veces no escribe dos veces", async () => {
    const { service, prisma, creados } = crear();
    prisma.ledgerJournal.findUnique.mockResolvedValueOnce({ id: "previo" });
    const r = await service.post({
      ...base,
      lines: [
        { account: "a:x", amountMinor: -1 },
        { account: "b:x", amountMinor: 1 },
      ],
    });
    expect(r).toEqual({ journalId: "previo", duplicate: true });
    expect(creados).toHaveLength(0);
  });

  it("anota a quién pertenece cada cuenta de persona", async () => {
    const { service, prisma } = crear();
    await service.post({
      ...base,
      lines: [
        { account: Accounts.ownerPayable("u-dueno"), amountMinor: 500 },
        { account: Accounts.platformCommission(), amountMinor: -500 },
      ],
    });
    const [[argumento]] = prisma.ledgerJournal.create.mock.calls as [
      [{ data: { entries: { create: { userId: string | null }[] } } }],
    ];
    const { data } = argumento;
    expect(data.entries.create.map((e) => e.userId)).toEqual(["u-dueno", null]);
  });
});
