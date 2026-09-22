import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { accountUserId } from "./accounts";

export interface LedgerLine {
  account: string;
  /** Con signo, en centavos: positivo entra a la cuenta, negativo sale. */
  amountMinor: number;
}

export interface JournalInput {
  /**
   * Lo que identifica al HECHO, no al pedido: "checkout:<pi>", "settle:<id>".
   * Si el mismo hecho se quiere asentar dos veces —un webhook repetido, el
   * cron y una persona liquidando a la vez—, el segundo intento no escribe
   * nada y devuelve el asiento que ya existía.
   */
  idempotencyKey: string;
  type: string;
  description: string;
  currency: string;
  bookingId?: string | null;
  actorId?: string | null;
  lines: LedgerLine[];
}

export interface PostResult {
  journalId: string;
  duplicate: boolean;
}

type Db = Prisma.TransactionClient | PrismaService;

/**
 * EL LIBRO CONTABLE DE PARTIDA DOBLE.
 *
 * Cada movimiento de plata es un asiento cuyas líneas SUMAN CERO: lo que sale
 * de una cuenta entra a otra. Es la regla más vieja de la contabilidad y la
 * razón es la misma que hace siglos: con ella, la plata no puede aparecer ni
 * desaparecer. Un error de programación que cobra de más o paga de menos deja
 * un asiento que no cierra, y ese asiento se rechaza acá, antes de escribirse.
 *
 * Nada se edita ni se borra. Una corrección es otro asiento, inverso, y los
 * dos quedan a la vista.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Asienta un movimiento. Puede ir dentro de una transacción de quien llama
   * (`db`), y conviene que vaya: el asiento y el cambio de estado que lo
   * motiva tienen que confirmarse juntos o no confirmarse.
   */
  async post(input: JournalInput, db: Db = this.prisma): Promise<PostResult> {
    const lines = input.lines.filter((line) => line.amountMinor !== 0);
    validar(input, lines);

    const existente = await db.ledgerJournal.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existente) return { journalId: existente.id, duplicate: true };

    try {
      const journal = await db.ledgerJournal.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          type: input.type,
          description: input.description,
          bookingId: input.bookingId ?? null,
          actorId: input.actorId ?? null,
          entries: {
            create: lines.map((line) => ({
              account: line.account,
              amountMinor: line.amountMinor,
              currency: input.currency,
              bookingId: input.bookingId ?? null,
              userId: accountUserId(line.account),
            })),
          },
        },
        select: { id: true },
      });
      return { journalId: journal.id, duplicate: false };
    } catch (error) {
      // Dos pedidos del mismo hecho a la vez: los dos pasaron el findUnique y
      // el unique de la base dejó entrar a uno solo. El otro es un duplicado,
      // no un error.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const ganador = await this.prisma.ledgerJournal.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (ganador) return { journalId: ganador.id, duplicate: true };
      }
      throw error;
    }
  }

  /** ¿Ya se asentó este hecho? */
  async exists(idempotencyKey: string, db: Db = this.prisma): Promise<boolean> {
    const journal = await db.ledgerJournal.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
    return Boolean(journal);
  }

  /** El saldo de una cuenta. */
  async balance(account: string, db: Db = this.prisma): Promise<number> {
    const result = await db.ledgerEntry.aggregate({
      where: { account },
      _sum: { amountMinor: true },
    });
    return result._sum.amountMinor ?? 0;
  }

  /**
   * Los saldos agrupados por cuenta, opcionalmente filtrados. Es la respuesta a
   * "¿cuánto hay en cada bolsillo?": las señas retenidas, lo que se le debe a
   * cada dueño, lo cobrado por cuenta de la aseguradora, la comisión.
   */
  async balances(
    filter: {
      prefix?: string;
      bookingId?: string;
      userId?: string;
    } = {},
  ): Promise<{ account: string; balanceMinor: number }[]> {
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ["account"],
      where: {
        ...(filter.prefix ? { account: { startsWith: filter.prefix } } : {}),
        ...(filter.bookingId ? { bookingId: filter.bookingId } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
      },
      _sum: { amountMinor: true },
      orderBy: { account: "asc" },
    });
    return rows.map((row) => ({
      account: row.account,
      balanceMinor: row._sum.amountMinor ?? 0,
    }));
  }

  /** Todos los asientos de una reserva, en orden, con sus líneas. */
  journalsForBooking(bookingId: string) {
    return this.prisma.ledgerJournal.findMany({
      where: { bookingId },
      orderBy: { createdAt: "asc" },
      include: {
        entries: {
          select: { account: true, amountMinor: true, currency: true },
          orderBy: { account: "asc" },
        },
      },
    });
  }
}

function validar(input: JournalInput, lines: LedgerLine[]): void {
  if (lines.length < 2) {
    throw new BadRequestException({
      statusCode: 400,
      code: "LEDGER_JOURNAL_EMPTY",
      message: "Un asiento necesita al menos dos líneas con monto.",
    });
  }
  for (const line of lines) {
    if (!Number.isInteger(line.amountMinor)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "LEDGER_AMOUNT_NOT_INTEGER",
        message: `El monto de ${line.account} no es un entero en centavos.`,
      });
    }
    if (!line.account || /\s/.test(line.account)) {
      throw new BadRequestException({
        statusCode: 400,
        code: "LEDGER_ACCOUNT_INVALID",
        message: `La cuenta "${line.account}" no es válida.`,
      });
    }
  }
  const suma = lines.reduce((total, line) => total + line.amountMinor, 0);
  if (suma !== 0) {
    // Un asiento que no cierra es plata que aparece o desaparece. No se
    // escribe nunca: es exactamente el error que la partida doble existe para
    // atrapar.
    throw new BadRequestException({
      statusCode: 400,
      code: "LEDGER_JOURNAL_UNBALANCED",
      message: `El asiento "${input.type}" no cierra: suma ${suma}.`,
    });
  }
}
