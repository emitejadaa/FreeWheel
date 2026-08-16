import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ListingStatus, MessageType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { assertFound } from "../common/utils/entity.util";
import { assertParticipant } from "../common/utils/authorization.util";
import { USER_PUBLIC_SELECT } from "../common/constants/prisma-select";

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

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
    const conv = await this.findOne(userId, conversationId);

    const message = await this.prisma.message.create({
      data: { conversationId, senderId: userId, content, type },
      include: { sender: { select: USER_PUBLIC_SELECT } },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    // El aviso por mail va DESPUÉS de guardar el mensaje y sin esperarlo: mandar
    // un mail tarda, y quien escribió no tiene por qué mirar la rueda girando
    // mientras tanto. Si el mail falla, el mensaje ya está guardado igual.
    void this.avisarMensajeSinLeer(conv, userId);

    return message;
  }

  async markAsRead(userId: string, conversationId: string) {
    await this.findOne(userId, conversationId);
    await this.prisma.message.updateMany({
      where: { conversationId, senderId: { not: userId }, readAt: null },
      data: { readAt: new Date() },
    });
    // Al abrir la conversación se borra la marca del último aviso: el próximo
    // mensaje que llegue después de esto vuelve a avisar. Sin esto, quien lee y
    // contesta al toque no se enteraría del mensaje siguiente hasta el otro día.
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastUnreadEmailAt: null },
    });
    return { ok: true };
  }

  /**
   * Le avisa por mail a la otra persona que tiene algo para leer.
   *
   * UNA SOLA VEZ POR CHARLA. Sin esto, escribir "hola", "¿estás?", "te paso la
   * dirección" son tres mails en un minuto, y el aviso deja de servir: se vuelve
   * ruido que se manda a la carpeta de spam junto con todo lo demás. La marca se
   * guarda en la persona que recibe y se borra cuando abre el chat.
   *
   * No manda nada si:
   *  · ya se le avisó y todavía no abrió la conversación;
   *  · apagó los avisos por mail (eso lo resuelve EmailService, que mira la
   *    preferencia antes de mandar cualquier aviso).
   *
   * Nunca tira una excepción: es un aviso, no puede hacer fallar el envío de un
   * mensaje que ya se guardó.
   */
  private async avisarMensajeSinLeer(
    conv: {
      id: string;
      ownerId: string;
      renterId: string;
      listing?: { title?: string | null } | null;
    },
    senderId: string,
  ) {
    try {
      const destinatarioId =
        conv.ownerId === senderId ? conv.renterId : conv.ownerId;

      const destinatario = await this.prisma.user.findUnique({
        where: { id: destinatarioId },
        select: {
          email: true,
          firstName: true,
          lastUnreadEmailAt: true,
        },
      });
      if (!destinatario) return;
      // Ya se le avisó y todavía no abrió la charla.
      if (destinatario.lastUnreadEmailAt) return;

      await this.prisma.user.update({
        where: { id: destinatarioId },
        data: { lastUnreadEmailAt: new Date() },
      });

      await this.email.sendUnreadMessages(destinatario.email, {
        recipientName: destinatario.firstName,
        listingLabel: conv.listing?.title ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `No se pudo avisar del mensaje sin leer en ${conv.id}: ${message}`,
      );
    }
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
