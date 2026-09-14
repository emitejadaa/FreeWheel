import { SetMetadata } from "@nestjs/common";

export const REQUIRE_DRIVING_ELIGIBILITY_KEY = "requireDrivingEligibility";

/**
 * Marca una ruta que solo puede usar alguien HABILITADO A CONDUCIR: licencia
 * vigente, de una clase que sirva para un auto y fuera del período de
 * principiante.
 *
 * Es distinto de @RequireVerifiedAccount() y por eso son dos decoradores. Estar
 * verificado es sobre la identidad y se resuelve una vez; estar habilitado es
 * sobre la licencia y cambia con el tiempo. Un dueño de auto que cobra un
 * alquiler tiene que estar verificado, pero no necesita poder manejar: si
 * fueran el mismo control, una licencia vencida le cortaría los cobros.
 *
 * Lo aplica VerifiedAccountGuard, que tiene que ir después de JwtAuthGuard en
 * @UseGuards.
 */
export const RequireDrivingEligibility = () =>
  SetMetadata(REQUIRE_DRIVING_ELIGIBILITY_KEY, true);
