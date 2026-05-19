import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ListingStatus, MessageType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async startOrGet(renterId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { ownerId: true, status: true },
    });

    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.ownerId === renterId)
      throw new BadRequestException('No podés iniciar una conversación con tu propia publicación');

    const existing = await this.prisma.conversation.findUnique({
      where: { listingId_renterId: { listingId, renterId } },
      include: this.convInclude(),
    });
    if (existing) return existing;

    if (listing.status !== ListingStatus.ACTIVE)
      throw new BadRequestException('Esta publicación no está disponible');

    return this.prisma.conversation.create({
      data: { listingId, renterId, ownerId: listing.ownerId },
      include: this.convInclude(),
    });
  }

  async findMine(userId: string) {
    return this.prisma.conversation.findMany({
      where: { OR: [{ renterId: userId }, { ownerId: userId }] },
      include: {
        ...this.convInclude(),
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
  }

  async findOne(userId: string, conversationId: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: this.convInclude(),
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (conv.renterId !== userId && conv.ownerId !== userId)
      throw new ForbiddenException('Not a participant');
    return conv;
  }

  async getMessages(userId: string, conversationId: string) {
    await this.findOne(userId, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
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
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, displayName: true } },
      },
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

  private convInclude() {
    const userSelect = {
      select: { id: true, firstName: true, lastName: true, displayName: true },
    };
    return {
      listing: {
        select: {
          id: true,
          title: true,
          vehicle: { select: { brand: true, model: true, year: true } },
        },
      },
      renter: userSelect,
      owner: userSelect,
    };
  }
}