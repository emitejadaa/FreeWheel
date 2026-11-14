# Defensa — Sprints 5 y 6

Para cada renglón de la presentación: **el archivo que hay que abrir** y las
líneas que hay que mostrar. Y abajo, **solo si el profesor pregunta**, el otro
archivo que conviene nombrar, con su ruta completa, la línea que hay que ver y
qué hace con el archivo principal.

Buscar `// -` en VS Code (Ctrl + Shift + F) muestra los 133 comentarios juntos.
Adentro del CSS son `/* - ...`, en JSX `{/* - ...` y en el HTML `<!-- - ...`.

Cada número apunta a la línea del **código**; el comentario está justo arriba.
Los del archivo principal llevan número de paso (`[Sesiones 3]`) y los demás
el tema sin número (`[Sesiones]`).

---

# Sprint 5

## 1. Sesiones con token y rutas protegidas según el rol

**Abrir:** `FreeWheel / src/auth/strategies/jwt.strategy.ts`
**Mostrar:** pasos 1 a 7 — líneas **30, 33, 41, 52, 57, 67 y 72**

Es lo que corre en **cada** pedido a una ruta protegida: saca el token del
header, verifica la firma, busca al usuario y devuelve su rol.

### Si te pregunta

- **¿Dónde se crea el token?** → `FreeWheel / src/auth/auth.service.ts`, línea
  **915**: la función `signToken` lo firma con la misma clave con la que lo
  verifica la línea 33 de este archivo. Se llama recién después de comparar la
  contraseña con bcrypt (línea 279 del mismo archivo).
- **¿Y si entro a /admin escribiendo la URL?** → `FreeWheel / src/common/guards/roles.guard.ts`,
  línea **39**: `requiredRoles.includes(user.role)`. Ese `user.role` es el que
  devuelve la línea 72 de acá. El front no muestra el panel, pero aunque lo
  saltees el pedido pasa igual por los dos y el back contesta 401 o 403.

---

## 2. Mails automáticos en cada paso de la cuenta y de la reserva

**Abrir:** `FreeWheel / src/email/email.service.ts`
**Mostrar:** los 7 pasos del mecanismo — líneas **23, 63, 98, 123, 163, 211 y 244**,
y como ejemplo completo la línea **802** (el comprobante con el QR adentro).

Los **códigos** (si no salen, es un error) y los **avisos** (respetan si la
persona los apagó) son dos caminos distintos: líneas 63 y 123.

### Los mails, uno por uno

| Tipo | Línea | Para qué |
|---|---|---|
| Código | 308 | verificar el email al registrarse |
| Código | 339 | verificar el teléfono (va por mail: un SMS es pago) |
| Código | 375 | confirmar un cambio de precio |
| Código | 417 | restablecer la contraseña |
| Aviso | 463 | al dueño: alguien quiere reservar su auto |
| Aviso | 506 | al que alquila: su pedido quedó registrado |
| Aviso | 549 | el dueño aceptó, ya se puede pagar |
| Aviso | 576 | el dueño rechazó |
| Aviso | 608 | la reserva se canceló |
| Aviso | 716 | comprobante de un pago |
| Aviso | 928 | al dueño: entró la plata |
| Aviso | 970 | entrega confirmada |
| Aviso | 1011 | devolución confirmada |
| Aviso | 1081 | actividad inusual, cuenta bloqueada un rato |
| Aviso | 1132 | se liberó el depósito |
| Aviso | 1202 | se cobró parte del depósito por un daño |
| Aviso | 1336 | tenés mensajes sin leer |

### Si te pregunta

- **¿Quién llama a estas funciones?** → `FreeWheel / src/bookings/bookings.service.ts`,
  línea **293**: `sendBookingAcceptedToRenter(...)`, que es la función de la
  línea 549 de acá. Es el ejemplo de quién dispara un mail.
- **¿Qué pasa si Gmail falla en medio de una reserva?** → mismo archivo, línea
  **1174**: `safeNotify` envuelve esas llamadas y atrapa el error, así la
  reserva se guarda igual.

---

## 3. La app en cinco idiomas

**Abrir:** `Fw / src/i18n/core.js`
**Mostrar:** pasos 1 a 8 — líneas **21, 29, 38, 40, 52, 54, 64 y 76**

Si falta una traducción sale en español: eso lo hace la línea 54.

### Si te pregunta

- **¿Cómo cambia toda la app al tocar un idioma?** → `Fw / src/i18n/index.jsx`,
  línea **37**: `useState(idiomaInicial)` llama a `idiomaInicial()` de la línea
  64 de acá y deja el idioma en un contexto de React. Al cambiarlo React vuelve
  a dibujar y cada `t("clave")` devuelve el texto nuevo, sin recargar la página.

---

## 4. Precios en la moneda que elija el usuario

**Abrir:** `Fw / src/services/moneda.js`
**Mostrar:** pasos 1 a 9 — líneas **47, 90, 109, 115, 127, 132, 137, 164 y 171**

La moneda elegida se guarda con `guardarMoneda`, línea **84**.

### Si te pregunta

- **¿Quién llama a esto?** → `Fw / src/context/CurrencyContext.jsx`, línea
  **41**: llama a `traerTasas()` de la línea 109 una sola vez al abrir la app. Y
  en la línea **54** envuelve a `formatearPrecio` de la línea 164 en la función
  `precio()`, que es la que usan todas las pantallas.
- **¿Se cobra en esa moneda?** → No. Se cobra en la moneda de la operación; la
  conversión es solo para que alguien de afuera entienda cuánto sale.

---

## 5. Modo oscuro en toda la app

**Abrir:** `Fw / src/services/theme.js`
**Mostrar:** pasos 1 a 9 — líneas **47, 50, 120, 123, 222, 228, 230, 625 y 639**

La idea en una frase: los colores son **variables de CSS**, y el botón solo
pone o saca la clase `fw-dark` del `<html>`.

### Si te pregunta

- **¿Dónde está el botón?** → `Fw / src/pages/Settings/Settings.jsx`, línea
  **93**: guarda la preferencia en `fw_prefs` y llama a `applyDarkMode`, que es
  la línea 625 de acá.
- **¿Cómo sabe cada componente qué color usar?** → No lo sabe. Ejemplo en
  `Fw / src/components/Layout.jsx`, línea **749**: escribe
  `background: "var(--fw-surface)"` y el navegador usa el valor que
  corresponda, el de la línea 50 o el de la 123. Hay más de 160 usos de esa
  variable en las pantallas.
- **¿Por qué no invertir los colores con un filtro?** → Antes era así y el azul
  de la marca salía celeste. Lo explica el comentario del principio de este
  mismo archivo.

---

## 6. Diseño adaptado al celular

**Abrir:** `Fw / src/hooks/useIsMobile.js`
**Mostrar:** pasos 1 a 7 — líneas **13, 15, 17, 24, 29, 32 y 36**

### Si te pregunta

- **¿Dónde se usa?** → En unos 30 archivos. El más claro es
  `Fw / src/components/Layout.jsx`, línea **526**: `{isMobile ? (` usa el valor
  que devuelve la línea 36 de acá, y en celular la barra lateral pasa a ser un
  menú que se abre con un botón.
- **¿Y el CSS?** → `Fw / src/styles/theme.css`, línea **442**:
  `@media (max-width: 767px)`, el mismo corte de 768 de la línea 15 pero del
  lado del CSS. Y la etiqueta `viewport` en `Fw / index.html`, línea **8**, que
  hace que el teléfono use su ancho real. El hook hace falta porque algunas
  cosas cambian la estructura, como el menú, y eso con CSS solo no se puede.

---

# Sprint 6

## 7. Modo lectura para personas con dislexia

**Abrir:** `Fw / src/services/theme.js`
**Mostrar:** pasos 1 a 6 — líneas **616, 528, 534, 553, 581 y 334**

Mismo mecanismo que el modo oscuro: una clase en el `<html>`, acá `fw-lectura`.
El botón está en `Fw / src/pages/Settings/Settings.jsx`, línea **95**.

---

## 8. Colores para personas con daltonismo

**Abrir:** `Fw / src/services/theme.js`
**Mostrar:** pasos 1 a 6 — líneas **607, 376, 381, 387, 431 y 433**

Lo que conviene remarcar: **no cambia todos los colores, solo los que se
confunden**, y las líneas 431 y 433 son las que hacen que funcione también con
el modo oscuro prendido al mismo tiempo. El botón está en
`Fw / src/pages/Settings/Settings.jsx`, línea **97**.

### Si te pregunta

- **¿Por qué no un filtro sobre toda la página?** → Un `filter` rompe lo que
  está fijo en pantalla, como la barra lateral y los modales, que se irían con
  el scroll. Cambiar las variables no rompe nada.
- **¿Y si alguien no distingue los colores igual?** → Los estados siempre llevan
  el texto al lado, como "verificado" o "cancelada", así el color nunca es lo
  único que informa.

---

## 9. Límites contra bots y cupos diarios

**Abrir:** `FreeWheel / src/common/rate-limit/sensitive-rate-limit.guard.ts`
**Mostrar:** pasos 1 a 9 — líneas **50, 52, 60, 68, 78, 85, 90, 109 y 119**

La frase para arrancar: **un tope en el navegador no es un tope** — se saltea
con F12. Por eso el contador vive en la base de datos del servidor.

### Si te pregunta

- **¿Y el límite general?** → `FreeWheel / src/app.module.ts`, línea **51**: 120
  pedidos por minuto por IP para toda la API. Es el primer nivel; este guard es
  el segundo.
- **¿Y los autos por día?** → `FreeWheel / src/antifraude/limites.ts`, línea
  **89**: `PUBLICACIONES_POR_DIA = 6`, que se revisa antes de crear cada
  publicación.
- **¿Por qué se cuenta en la base y no en memoria?** → En Vercel cada instancia
  del servidor arranca de cero, así que un contador en memoria se reiniciaría
  solo. En la base lo ven todas.

---

## 10. Pruebas automáticas y corrección de errores

**Abrir:** `FreeWheel / src/common/utils/cuil.util.spec.ts`
**Mostrar:** pasos 1 a 5 — líneas **13, 15, 17, 23 y 25**

`describe` agrupa, cada `it` es un caso escrito como una frase, y `expect` dice
qué tiene que devolver. Se prueban los casos buenos **y** los de error.

### Si te pregunta

- **¿Qué función prueban?** → `FreeWheel / src/common/utils/cuil.util.ts`, línea
  **25**: `cuilChecksumValid`. Cada archivo de prueba está al lado del que
  prueba: `cuil.util.ts` y `cuil.util.spec.ts`.
- **¿Qué errores corrigieron?** → Uno para contar está en
  `Fw / src/pages/Admin/Admin.jsx`, línea **184**: el panel quedaba en blanco
  si el rol cambiaba con la pantalla abierta, porque React cambiaba la cantidad
  de hooks entre un dibujo y otro. El comentario largo de abajo explica por qué
  la comprobación tiene que ir después de todos los hooks y no antes.

---

## Si preguntan por los números

| | Front (Fw) | Back (FreeWheel) |
|---|---|---|
| Pruebas automáticas | 510 | 578 en 47 suites |
| Archivos de prueba | 26 | 47 |
| Idiomas | 1626 claves × 5 | — |
| Comentarios de esta guía | 67 | 66 |
