import { BadRequestException, Injectable } from "@nestjs/common";
import { ListingStatus, MessageType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { USER_PUBLIC_SELECT } from "../common/constants/prisma-select";

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async startOrGet(renterId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { ownerId: true, status: true },
    });

    assertFound(listing, "Listing not found");
    if (listing.ownerId === renterId) {
      throw new BadRequestException(
        "You cannot start a conversation with your own listing",
      );
    }

    const existing = await this.prisma.conversation.findUnique({
      where: { listingId_renterId: { listingId, renterId } },
      include: this.conversationInclude(),
    });
    if (existing) return existing;

    // Allow reopening an existing thread, but only start a new one while the
    // listing is still active.
    if (listing.status !== ListingStatus.ACTIVE) {
      throw new BadRequestException("This listing is not available");
    }

    return this.prisma.conversation.create({
      data: { listingId, renterId, ownerId: listing.ownerId },
      include: this.conversationInclude(),
    });
  }

  async findMine(userId: string) {
    return this.prisma.conversation.findMany({
      where: { OR: [{ renterId: userId }, { ownerId: userId }] },
      include: {
        ...this.conversationInclude(),
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { lastMessageAt: "desc" },
    });
  }

  async findOne(userId: string, conversationId: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: this.conversationInclude(),
    });
    assertFound(conv, "Conversation not found");
    assertParticipant(conv.ownerId, conv.renterId, userId, "Not a participant");
    return conv;
  }

  async getMessages(userId: string, conversationId: string) {
    await this.findOne(userId, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      include: { sender: { select: USER_PUBLIC_SELECT } },
      orderBy: { createdAt: "asc" },
    });
  }

  async sendMessage(
    userId: string,
    conversationId: string,
    content: string,
    type: MessageType = MessageType.TEXT,
  ) {
    await this.findOne(userId, conversationId);

    const message = await this.prisma.message.create({
      data: { conversationId, senderId: userId, content, type },
      include: { sender: { select: USER_PUBLIC_SELECT } },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    return message;
  }

  async markAsRead(userId: string, conversationId: string) {
    await this.findOne(userId, conversationId);
    await this.prisma.message.updateMany({
      where: { conversationId, senderId: { not: userId }, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  private conversationInclude() {
    return {
      listing: {
        select: {
          id: true,
          title: true,
          vehicle: { select: { brand: true, model: true, year: true } },
        },
      },
      renter: { select: USER_PUBLIC_SELECT },
      owner: { select: USER_PUBLIC_SELECT },
    };
  }
}
