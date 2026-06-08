import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, VerifyCallback } from "passport-google-oauth20";
import { getPublicApiBaseUrl } from "../../config/public-urls";

export interface GoogleProfilePayload {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  profilePhotoUrl: string | null;
}

// Shape of the relevant fields from a passport-google-oauth20 profile.
interface GoogleProfile {
  id: string;
  name: { givenName?: string; familyName?: string };
  emails: { value: string }[];
  photos?: { value: string }[];
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>("GOOGLE_CLIENT_ID") ?? "",
      clientSecret: configService.get<string>("GOOGLE_CLIENT_SECRET") ?? "",
      callbackURL: `${getPublicApiBaseUrl(configService)}/auth/google/callback`,
      scope: ["email", "profile"],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: GoogleProfile,
    done: VerifyCallback,
  ) {
    const { id, name, emails, photos } = profile;
    const payload: GoogleProfilePayload = {
      googleId: id,
      email: emails[0].value,
      firstName: name.givenName ?? "",
      lastName: name.familyName ?? "",
      profilePhotoUrl: photos?.[0]?.value ?? null,
    };
    done(null, payload);
  }
}
