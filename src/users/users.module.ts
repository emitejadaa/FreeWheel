import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [PrismaModule, AuthModule, StorageModule],
  providers: [UsersService],
  controllers: [UsersController],
})
export class UsersModule {}
