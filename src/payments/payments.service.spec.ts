import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import {
  BookingStatus,
  PaymentRecordStatus,
  PaymentStatus,
} from "@prisma/client";
import { AuditLogService } from "../common/services/audit-log.service";
import { PrismaService } from "../prisma/prisma.service";
import { MockPaymentsProvider } from "./providers/mock-payments.provider";
import { PaymentsService } from "./payments.service";

describe("PaymentsService", () => {
  let service: PaymentsService;
  let prisma: {
    booking: { findUnique: jest.Mock; update: jest.Mock };
    paymentRecord: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  const booking = {
    id: "booking-1",
    renterId: "renter-1",
    ownerId: "owner-1",
    status: BookingStatus.ACCEPTED,
    paymentStatus: PaymentStatus.PENDING,
    totalPriceSnapshot: 250,
    currency: "ARS",
  };

  beforeEach(async () => {
    prisma = {
      booking: {
        findUnique: jest.fn().mockResolvedValue(booking),
        update: jest.fn(),
      },
      paymentRecord: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        MockPaymentsProvider,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: { create: jest.fn() } },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  it("creates a mock payment intent for the renter", async () => {
    prisma.paymentRecord.findFirst.mockResolvedValue(null);
    prisma.paymentRecord.create.mockResolvedValue({
      id: "payment-1",
      status: PaymentRecordStatus.PENDING,
    });

    const result = await service.createMockIntent("renter-1", booking.id);

    expect(result.status).toBe(PaymentRecordStatus.PENDING);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentStatus: PaymentStatus.PENDING }),
      }),
    );
  });

  it("rejects payment creation by non renter participants", async () => {
    await expect(
      service.createMockIntent("owner-1", booking.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("confirms a mock payment", async () => {
    prisma.paymentRecord.findFirst.mockResolvedValue({
      id: "payment-1",
      status: PaymentRecordStatus.PENDING,
      metadata: {},
    });
    prisma.paymentRecord.update.mockResolvedValue({
      id: "payment-1",
      status: PaymentRecordStatus.PAID,
    });

    const result = await service.confirmMockPayment("renter-1", booking.id);

    expect(result.status).toBe(PaymentRecordStatus.PAID);
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentStatus: PaymentStatus.PAID }),
      }),
    );
  });

  it("requires an existing mock intent before confirm", async () => {
    prisma.paymentRecord.findFirst.mockResolvedValue(null);

    await expect(
      service.confirmMockPayment("renter-1", booking.id),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects mock confirmation by non participants", async () => {
    await expect(
      service.confirmMockPayment("other-user", booking.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
