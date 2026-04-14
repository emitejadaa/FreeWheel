import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class TokenService {
  constructor(private jwtService: JwtService) {}

  generateAccessToken(userId: string, email: string): string {
    return this.jwtService.sign(
      { email },
      {
        subject: userId,
        expiresIn: '24h',
      },
    );
  }

  generateRefreshToken(userId: string): string {
    return this.jwtService.sign(
      {},
      {
        subject: userId,
        expiresIn: '7d',
      },
    );
  }
}
