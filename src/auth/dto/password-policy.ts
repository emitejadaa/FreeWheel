/**
 * LA REGLA DE LAS CONTRASEÑAS, EN UN SOLO LUGAR.
 *
 * Vale para todo lo que PONE una contraseña (registrarse, recuperarla). No
 * para el login: una cuenta creada cuando el mínimo era 6 tiene que poder
 * seguir entrando con la contraseña que eligió en su momento, y pedirle 8 al
 * entrar la dejaría afuera sin ninguna salida más que recuperarla.
 *
 * ── Por qué 8 ───────────────────────────────────────────────────────────────
 * Es el mínimo que recomienda NIST para contraseñas elegidas por personas, y
 * la diferencia con 6 no es chica: cada carácter multiplica las combinaciones,
 * y con dos más una contraseña que se rompía en horas probando offline contra
 * un hash filtrado pasa a llevar meses.
 *
 * ── Por qué un máximo ───────────────────────────────────────────────────────
 * bcrypt solo mira los primeros 72 bytes: más allá no agrega nada. El máximo
 * existe para que nadie mande un megabyte como "contraseña" y nos haga pasarlo
 * por el hash, que es justamente lo que está hecho para ser caro.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_LENGTH_MESSAGE =
  `La contraseña tiene que tener entre ${PASSWORD_MIN_LENGTH} y ` +
  `${PASSWORD_MAX_LENGTH} caracteres`;

/**
 * El costo de bcrypt para las contraseñas nuevas.
 *
 * 12 y no 10: son 4 veces más caras de probar para quien se lleve la tabla de
 * usuarios, a cambio de ~250 ms por login, que una persona no nota. Comparar
 * sigue andando con los hashes viejos de costo 10 —el costo viaja adentro del
 * propio hash—, y el login los reescribe a 12 la próxima vez que la persona
 * entra (ver AuthService).
 *
 * Los códigos de verificación siguen en 10: son de un solo uso, vencen en
 * minutos y tienen tope de intentos, así que el costo extra no compra nada.
 *
 * EN LAS PRUEBAS, 4. Una suite que registra tres o cuatro cuentas por caso
 * gasta segundos enteros solamente hasheando, y lo que se está probando no es
 * bcrypt: el costo no cambia ningún comportamiento, solo cuánto tarda. Se
 * decide por NODE_ENV y no por una variable, para que no exista la forma de
 * dejar un deploy con contraseñas hasheadas a costo 4.
 */
export const PASSWORD_HASH_COST = process.env.NODE_ENV === "test" ? 4 : 12;
