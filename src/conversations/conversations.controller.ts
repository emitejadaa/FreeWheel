import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../common/types/current-user.type';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  startOrGet(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationsService.startOrGet(user.id, dto.listingId);
  }

  @Get('me')
  findMine(@CurrentUser() user: CurrentUserPayload) {
    return this.conversationsService.findMine(user.id);
  }

  @Get(':id')
  findOne(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.conversationsService.findOne(user.id, id);
  }

  @Get(':id/messages')
  getMessages(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.conversationsService.getMessages(user.id, id);
  }

  @Post(':id/messages')
  sendMessage(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.conversationsService.sendMessage(
      user.id,
      id,
      dto.content,
      dto.type,
    );
  }

  @Patch(':id/read')
  markAsRead(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.conversationsService.markAsRead(user.id, id);
  }
}