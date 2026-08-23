import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/app";
import { cleanDatabase } from "./helpers/db";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  createListing,
  createVehicle,
  futureDate,
  registerUser,
} from "./helpers/factory";

describe("Listings", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
  });

  describe("creation & ownership", () => {
    it("creates a listing for an owned vehicle", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      expect(listing.id).toEqual(expect.any(String));
    });

    it("rejects creating a listing for someone else's vehicle (403)", async () => {
      const owner = await registerUser(app);
      const other = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);

      await request(app.getHttpServer())
        .post("/listings")
        .set("Authorization", `Bearer ${other.token}`)
        .send({
          vehicleId: vehicle.id,
          title: "Trying to steal",
          description: "This should be forbidden for non-owners.",
          pricePerDay: 1000,
          locationText: "Nowhere",
          latitude: -34.6,
          longitude: -58.4,
        })
        .expect(403);
    });

    it("returns 404 when the vehicle does not exist", async () => {
      const owner = await registerUser(app);
      await request(app.getHttpServer())
        .post("/listings")
        .set("Authorization", `Bearer ${owner.token}`)
        .send({
          vehicleId: "00000000-0000-0000-0000-000000000000",
          title: "Ghost vehicle",
          description: "No such vehicle exists in the database.",
          pricePerDay: 1000,
          locationText: "Nowhere",
          latitude: -34.6,
          longitude: -58.4,
        })
        .expect(404);
    });

    it("only the owner can update or delete a listing", async () => {
      const owner = await registerUser(app);
      const other = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${other.token}`)
        .send({ pricePerDay: 9999 })
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ title: "Updated title" })
        .expect(200);
    });

    it("does not let PATCH change the price (that needs the emailed code)", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      // The price is the one field that moves money on its own, so it has its
      // own confirmed flow. A plain PATCH must be refused, with an explanation.
      const res = await request(app.getHttpServer())
        .patch(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ pricePerDay: 9999 })
        .expect(400);
      expect(String(res.body.message)).toContain("Cambiar precio");
    });
  });

  // La ubicación es un solo punto dicho de dos maneras (una dirección escrita y
  // una coordenada) más un radio de entrega alrededor de ese punto. El front
  // mantiene las dos formas atadas con el mapa; estos tests fijan que el back no
  // acepte una publicación a la que le falte una de las dos, ni un cambio que
  // las deje apuntando a lugares distintos.
  describe("ubicación y radio de entrega", () => {
    const point = { latitude: -34.6037, longitude: -58.3816 };

    async function ownedVehicle() {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      return { owner, vehicle };
    }

    function postListing(token: string, body: Record<string, unknown>) {
      return request(app.getHttpServer())
        .post("/listings")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
    }

    const base = (vehicleId: string) => ({
      vehicleId,
      title: "Auto con ubicación",
      description: "Publicación para probar la ubicación del aviso.",
      pricePerDay: 4000,
      locationText: "Av. de Mayo 500, CABA",
    });

    it("guarda y devuelve los cuatro datos de ubicación", async () => {
      const { owner, vehicle } = await ownedVehicle();
      const created = await postListing(owner.token, {
        ...base(vehicle.id),
        ...point,
        deliveryRadiusM: 7500,
        status: "ACTIVE",
      }).expect(201);

      expect(created.body).toMatchObject({
        locationText: "Av. de Mayo 500, CABA",
        ...point,
        deliveryRadiusM: 7500,
      });

      // Y siguen estando en el catálogo público y en el detalle, que es de donde
      // el front los lee para dibujar el mapa y filtrar por zona.
      const list = await request(app.getHttpServer())
        .get("/listings")
        .expect(200);
      expect(list.body.data[0]).toMatchObject({
        locationText: "Av. de Mayo 500, CABA",
        ...point,
        deliveryRadiusM: 7500,
      });

      const detail = await request(app.getHttpServer())
        .get(`/listings/${created.body.id}`)
        .expect(200);
      expect(detail.body).toMatchObject({ ...point, deliveryRadiusM: 7500 });
    });

    it("sin entrega declarada el radio queda en 0, no en null", async () => {
      const { owner, vehicle } = await ownedVehicle();
      const created = await postListing(owner.token, {
        ...base(vehicle.id),
        ...point,
      }).expect(201);

      expect(created.body.deliveryRadiusM).toBe(0);
    });

    it("no se puede publicar sin coordenada, ni con una imposible", async () => {
      const { owner, vehicle } = await ownedVehicle();

      await postListing(owner.token, base(vehicle.id)).expect(400);
      await postListing(owner.token, {
        ...base(vehicle.id),
        latitude: point.latitude,
      }).expect(400);
      await postListing(owner.token, {
        ...base(vehicle.id),
        latitude: 91,
        longitude: point.longitude,
      }).expect(400);
      await postListing(owner.token, {
        ...base(vehicle.id),
        latitude: point.latitude,
        longitude: -181,
      }).expect(400);
    });

    it("rechaza radios negativos, con decimales o desmedidos", async () => {
      const { owner, vehicle } = await ownedVehicle();

      for (const deliveryRadiusM of [-1, 1500.5, 200_001]) {
        await postListing(owner.token, {
          ...base(vehicle.id),
          ...point,
          deliveryRadiusM,
        }).expect(400);
      }
    });

    it("al editar, la dirección y la coordenada se cambian juntas", async () => {
      const { owner, vehicle } = await ownedVehicle();
      const listing = await createListing(app, owner.token, vehicle.id);

      const patch = (body: Record<string, unknown>) =>
        request(app.getHttpServer())
          .patch(`/listings/${listing.id}`)
          .set("Authorization", `Bearer ${owner.token}`)
          .send(body);

      // Sólo el texto dejaría la dirección diciendo una cosa y el pin otra.
      const soloTexto = await patch({ locationText: "Belgrano, CABA" }).expect(
        400,
      );
      expect(String(soloTexto.body.message)).toContain("ubicación");
      await patch({ latitude: point.latitude }).expect(400);
      await patch({ ...point }).expect(400);

      // Las tres juntas sí.
      const ok = await patch({
        locationText: "Belgrano, CABA",
        ...point,
      }).expect(200);
      expect(ok.body).toMatchObject({
        locationText: "Belgrano, CABA",
        ...point,
      });
    });

    it("el radio de entrega se puede cambiar solo", async () => {
      const { owner, vehicle } = await ownedVehicle();
      const listing = await createListing(app, owner.token, vehicle.id);

      const res = await request(app.getHttpServer())
        .patch(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ deliveryRadiusM: 20_000 })
        .expect(200);
      expect(res.body.deliveryRadiusM).toBe(20_000);
    });

    it("los campos viejos de entrega ya no existen", async () => {
      const { owner, vehicle } = await ownedVehicle();

      await postListing(owner.token, {
        ...base(vehicle.id),
        ...point,
        deliveryLatitude: -34.6,
        deliveryLongitude: -58.4,
      }).expect(400);

      await postListing(owner.token, {
        ...base(vehicle.id),
        ...point,
        deliveryRadiusKm: 10,
      }).expect(400);
    });
  });

  describe("public catalog", () => {
    it("lists only ACTIVE listings with pagination metadata", async () => {
      const owner = await registerUser(app);
      const v1 = await createVehicle(app, owner.token, { brand: "Ford" });
      await createListing(app, owner.token, v1.id, { pricePerDay: 3000 });

      const res = await request(app.getHttpServer())
        .get("/listings")
        .expect(200);
      expect(res.body).toMatchObject({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(res.body.data).toHaveLength(1);
    });

    it("supports price/brand filters and price sorting", async () => {
      const owner = await registerUser(app);
      const cheap = await createVehicle(app, owner.token, { brand: "Fiat" });
      const pricey = await createVehicle(app, owner.token, { brand: "BMW" });
      await createListing(app, owner.token, cheap.id, { pricePerDay: 2000 });
      await createListing(app, owner.token, pricey.id, { pricePerDay: 8000 });

      const byBrand = await request(app.getHttpServer())
        .get("/listings")
        .query({ brand: "BMW" })
        .expect(200);
      expect(byBrand.body.total).toBe(1);

      const byPrice = await request(app.getHttpServer())
        .get("/listings")
        .query({ maxPrice: 3000 })
        .expect(200);
      expect(byPrice.body.total).toBe(1);

      const asc = await request(app.getHttpServer())
        .get("/listings")
        .query({ sort: "priceAsc" })
        .expect(200);
      expect(asc.body.data[0].pricePerDay).toBe(2000);
    });

    it("soft-deleted listings disappear from the catalog and 404 on detail", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);

      await request(app.getHttpServer())
        .delete(`/listings/${listing.id}`)
        .set("Authorization", `Bearer ${owner.token}`)
        .expect(200);

      const catalog = await request(app.getHttpServer())
        .get("/listings")
        .expect(200);
      expect(catalog.body.total).toBe(0);
      await request(app.getHttpServer())
        .get(`/listings/${listing.id}`)
        .expect(404);
    });
  });

  describe("availability & manual blocks", () => {
    it("reports availability and reflects a manual block", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const startDate = futureDate(10);
      const endDate = futureDate(13);

      const free = await request(app.getHttpServer())
        .get(`/listings/${listing.id}/availability`)
        .query({ startDate, endDate })
        .expect(200);
      expect(free.body.available).toBe(true);

      await request(app.getHttpServer())
        .post(`/listings/${listing.id}/availability-blocks`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ startDate, endDate, reason: "Maintenance" })
        .expect(201);

      const blocked = await request(app.getHttpServer())
        .get(`/listings/${listing.id}/availability`)
        .query({ startDate, endDate })
        .expect(200);
      expect(blocked.body.available).toBe(false);
      expect(blocked.body.manualBlocks).toHaveLength(1);
    });

    it("rejects overlapping blocks and forbids non-owners", async () => {
      const owner = await registerUser(app);
      const other = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const startDate = futureDate(20);
      const endDate = futureDate(25);

      await request(app.getHttpServer())
        .post(`/listings/${listing.id}/availability-blocks`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ startDate, endDate })
        .expect(201);

      // Overlapping block for the same listing is rejected.
      await request(app.getHttpServer())
        .post(`/listings/${listing.id}/availability-blocks`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ startDate: futureDate(22), endDate: futureDate(27) })
        .expect(400);

      // A non-owner cannot manage blocks.
      await request(app.getHttpServer())
        .get(`/listings/${listing.id}/availability-blocks`)
        .set("Authorization", `Bearer ${other.token}`)
        .expect(403);
    });
  });
  /**
   * El orden de las fotos decide cuál es la portada: la que se ve en el
   * buscador, en el inicio, en el globo del mapa y en "Mis autos". Antes era el
   * orden de subida y no se podía cambiar sin borrar la publicación entera.
   */
  describe("photo order", () => {
    const subirFoto = async (token: string, vehicleId: string, n: number) => {
      const res = await request(app.getHttpServer())
        .post("/media/assets")
        .set("Authorization", `Bearer ${token}`)
        .send({
          kind: "VEHICLE_PHOTO",
          url: `https://cdn.example.com/foto-${n}.jpg`,
          entityType: "vehicle",
          entityId: vehicleId,
        })
        .expect(201);
      return res.body.url as string;
    };

    const fotosDe = async (listingId: string) => {
      const res = await request(app.getHttpServer())
        .get(`/listings/${listingId}`)
        .expect(200);
      return res.body.photos as string[];
    };

    it("the owner reorders the photos and everyone sees the new order", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const fotos = [
        await subirFoto(owner.token, vehicle.id, 1),
        await subirFoto(owner.token, vehicle.id, 2),
        await subirFoto(owner.token, vehicle.id, 3),
      ];

      // Sin tocar nada, salen en el orden en que se subieron.
      expect(await fotosDe(listing.id)).toEqual(fotos);

      const nuevo = [fotos[2], fotos[0], fotos[1]];
      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}/photos`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ photos: nuevo })
        .expect(200);

      // Y la lista pública —la que ve cualquiera, sin sesión— cambió.
      expect(await fotosDe(listing.id)).toEqual(nuevo);
    });

    it("the new cover also travels to the search results", async () => {
      // La portada no sirve de nada si solo cambia adentro de la publicación:
      // lo que se ve primero es la tarjeta del buscador.
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const fotos = [
        await subirFoto(owner.token, vehicle.id, 1),
        await subirFoto(owner.token, vehicle.id, 2),
      ];

      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}/photos`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ photos: [fotos[1], fotos[0]] })
        .expect(200);

      const busqueda = await request(app.getHttpServer())
        .get("/listings")
        .expect(200);
      const encontrada = (busqueda.body.data as { id: string; photos: string[] }[])
        .find((l) => l.id === listing.id);
      expect(encontrada?.photos[0]).toBe(fotos[1]);
    });

    it("a photo uploaded afterwards goes to the end, it does not steal the cover", async () => {
      // El caso que rompe si la posición nueva arranca en 0: el dueño elige su
      // portada, sube otra foto, y la portada le cambia sola.
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const fotos = [
        await subirFoto(owner.token, vehicle.id, 1),
        await subirFoto(owner.token, vehicle.id, 2),
      ];

      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}/photos`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ photos: [fotos[1], fotos[0]] })
        .expect(200);

      const tercera = await subirFoto(owner.token, vehicle.id, 3);
      expect(await fotosDe(listing.id)).toEqual([fotos[1], fotos[0], tercera]);
    });

    it("rejects a list that does not match the listing's photos (400)", async () => {
      const owner = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const fotos = [
        await subirFoto(owner.token, vehicle.id, 1),
        await subirFoto(owner.token, vehicle.id, 2),
      ];

      // Falta una.
      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}/photos`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ photos: [fotos[0]] })
        .expect(400);

      // Una repetida en lugar de la otra.
      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}/photos`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ photos: [fotos[0], fotos[0]] })
        .expect(400);

      // Una que no es de este auto.
      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}/photos`)
        .set("Authorization", `Bearer ${owner.token}`)
        .send({ photos: [fotos[0], "https://cdn.example.com/ajena.jpg"] })
        .expect(400);

      // Y después de todos los rechazos, el orden sigue intacto.
      expect(await fotosDe(listing.id)).toEqual(fotos);
    });

    it("only the owner can reorder", async () => {
      const owner = await registerUser(app);
      const other = await registerUser(app);
      const vehicle = await createVehicle(app, owner.token);
      const listing = await createListing(app, owner.token, vehicle.id);
      const fotos = [
        await subirFoto(owner.token, vehicle.id, 1),
        await subirFoto(owner.token, vehicle.id, 2),
      ];

      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}/photos`)
        .set("Authorization", `Bearer ${other.token}`)
        .send({ photos: [fotos[1], fotos[0]] })
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/listings/${listing.id}/photos`)
        .send({ photos: [fotos[1], fotos[0]] })
        .expect(401);

      expect(await fotosDe(listing.id)).toEqual(fotos);
    });
  });
});
