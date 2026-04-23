import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  generateAccessToken(user: Pick<User, 'id' | 'email'>): string {
    return this.jwtService.sign(
      { email: user.email },
      {
        subject: user.id,
      },
    );
  }

  async createRefreshToken(userId: string, previousToken?: string) {
    const rawToken = randomBytes(48).toString('hex');
    const expiresAt = this.getRefreshTokenExpiresAt();

    const previousRecord = previousToken
      ? await this.prisma.refreshToken.findUnique({
          where: { tokenHash: this.hashValue(previousToken) },
        })
      : null;

    const createdToken = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashValue(rawToken),
        expiresAt,
      },
    });

    if (previousRecord && !previousRecord.revokedAt) {
      await this.prisma.refreshToken.update({
        where: { id: previousRecord.id },
        data: {
          revokedAt: new Date(),
          replacedById: createdToken.id,
        },
      });
    }

    return rawToken;
  }

  async rotateRefreshToken(refreshToken: string) {
    const tokenHash = this.hashValue(refreshToken);
    const tokenRecord = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.revokedAt || tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token inválido.');
    }

    await this.prisma.refreshToken.update({
      where: { id: tokenRecord.id },
      data: {
        lastUsedAt: new Date(),
      },
    });

    return tokenRecord.user;
  }

  async revokeRefreshToken(refreshToken: string) {
    const tokenHash = this.hashValue(refreshToken);
    const tokenRecord = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!tokenRecord || tokenRecord.revokedAt) {
      return;
    }

    await this.prisma.refreshToken.update({
      where: { id: tokenRecord.id },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  private hashValue(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private getRefreshTokenExpiresAt() {
    const ttl = process.env.JWT_REFRESH_TOKEN_TTL ?? '7d';
    const match = ttl.match(/^(\d+)([dhm])$/);

    if (!match) {
      const date = new Date();
      date.setDate(date.getDate() + 7);
      return date;
    }

    const value = Number(match[1]);
    const unit = match[2];
    const date = new Date();

    if (unit === 'd') {
      date.setDate(date.getDate() + value);
    } else if (unit === 'h') {
      date.setHours(date.getHours() + value);
    } else {
      date.setMinutes(date.getMinutes() + value);
    }

    return date;
  }
}
