import { Controller, Get } from "@nestjs/common";

/**
 * `GET /` es la prueba de vida que usan los checkers de deploy
 * (scripts/endpoint-checker) y la suite: solo importa que conteste 200.
 */
@Controller()
export class AppController {
  @Get()
  root() {
    return { name: "FreeWheel API", status: "ok" };
  }
}
