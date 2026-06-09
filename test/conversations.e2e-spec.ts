import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  AuthedUser,
  createListing,
  createVehicle,
  registerUser,
} from "./helpers/factory";

describe("Conversations", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  async function setup(): Promise<{
    owner: AuthedUser;
    renter: AuthedUser;
    listingId: string;
  }> {
    const owner = await registerUser(app);
    const vehicle = await createVehicle(app, owner.token);
    const listing = await createListing(app, owner.token, vehicle.id);
    const renter = await registerUser(app);
    return { owner, renter, listingId: listing.id };
  }

  it("starts (and reuses) a conversation, exchanges messages, marks read", async () => {
    const { owner, renter, listingId } = await setup();

    const started = await http()
      .post("/conversations")
      .set("Authorization", auth(renter.token))
      .send({ listingId })
      .expect(201);
    const conversationId = started.body.id;

    // Starting again returns the SAME conversation.
    const again = await http()
      .post("/conversations")
      .set("Authorization", auth(renter.token))
      .send({ listingId })
      .expect(201);
    expect(again.body.id).toBe(conversationId);

    const mine = await http()
      .get("/conversations/me")
      .set("Authorization", auth(renter.token))
      .expect(200);
    expect(mine.body).toHaveLength(1);

    const message = await http()
      .post(`/conversations/${conversationId}/messages`)
      .set("Authorization", auth(renter.token))
      .send({ content: "Hi, is the car available?" })
      .expect(201);
    expect(message.body.content).toBe("Hi, is the car available?");

    const messages = await http()
      .get(`/conversations/${conversationId}/messages`)
      .set("Authorization", auth(owner.token))
      .expect(200);
    expect(messages.body.length).toBeGreaterThanOrEqual(1);

    await http()
      .patch(`/conversations/${conversationId}/read`)
      .set("Authorization", auth(owner.token))
      .expect(200);
  });

  it("forbids starting a conversation on your own listing", async () => {
    const { owner, listingId } = await setup();
    await http()
      .post("/conversations")
      .set("Authorization", auth(owner.token))
      .send({ listingId })
      .expect(400);
  });

  it("forbids non-participants from reading a conversation", async () => {
    const { renter, listingId } = await setup();
    const started = await http()
      .post("/conversations")
      .set("Authorization", auth(renter.token))
      .send({ listingId })
      .expect(201);
    const stranger = await registerUser(app);
    await http()
      .get(`/conversations/${started.body.id}`)
      .set("Authorization", auth(stranger.token))
      .expect(403);
  });

  it("does not start a new conversation when the listing is not active", async () => {
    const { owner, listingId } = await setup();
    await http()
      .patch(`/listings/${listingId}`)
      .set("Authorization", auth(owner.token))
      .send({ status: "DRAFT" })
      .expect(200);

    const newRenter = await registerUser(app);
    await http()
      .post("/conversations")
      .set("Authorization", auth(newRenter.token))
      .send({ listingId })
      .expect(400);
  });

  it("returns 404 for an unknown conversation", async () => {
    const { renter } = await setup();
    await http()
      .get("/conversations/00000000-0000-0000-0000-000000000000")
      .set("Authorization", auth(renter.token))
      .expect(404);
  });
});
