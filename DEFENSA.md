# Defensa — Sprints 5 y 6

Para cada renglón de la presentación: **el archivo que hay que abrir**, las
líneas que hay que mostrar, y **qué otros archivos están enganchados con ese**,
diciendo en cada caso qué línea los une y por qué.

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

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| Fw / `src/pages/Auth/Login.jsx` | 81 | `await loginWithCredentials(...)` — el formulario arranca toda la cadena |
| Fw / `src/context/AuthContext.jsx` | 140 | esa función: le pide el token al back |
| Fw / `src/context/AuthContext.jsx` | 75 | `localStorage.setItem(STORAGE_KEY, ...)` — el token queda guardado acá |
| Fw / `src/services/api.js` | 76 | **la línea que une el front con el back**: manda ese mismo token como `Authorization: Bearer`, que es exactamente de donde lo saca la línea 30 de la estrategia |
| Fw / `src/services/api.js` | 128 | `if (res.status === 401 ...)` — cuando la estrategia rechaza el token, acá se borra la sesión y se va al login |
| Fw / `src/App.jsx` | 54 | `const priv = ...` envuelve con `PrivateRoute` las pantallas privadas |
| Fw / `src/components/PrivateRoute.jsx` | 19 | sin sesión redirige al login. Solo esconde pantallas: la seguridad real es la del back |
| FreeWheel / `src/auth/auth.controller.ts` | 113 | `@Post("login")` — la ruta que entrega el token |
| FreeWheel / `src/auth/auth.service.ts` | 279 | `bcrypt.compare(...)` — compara la contraseña contra el hash |
| FreeWheel / `src/auth/auth.service.ts` | 915 | `signToken` — **acá se firma** con la misma clave que verifica la línea 33 de la estrategia |
| FreeWheel / `src/common/decorators/roles.decorator.ts` | 7 | `@Roles(...)` marca qué roles puede usar una ruta |
| FreeWheel / `src/common/guards/roles.guard.ts` | 13 | lee esos roles |
| FreeWheel / `src/common/guards/roles.guard.ts` | 39 | `requiredRoles.includes(user.role)` — **ese `user.role` es el que devuelve la línea 72 de la estrategia**. Ahí se cierra el circuito |
| FreeWheel / `src/admin/admin.controller.ts` | 30 | `@UseGuards(JwtAuthGuard, RolesGuard)` — los dos juntos: primero quién sos, después si podés |

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

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| FreeWheel / `src/bookings/bookings.service.ts` | 293 | `this.email.sendBookingAcceptedToRenter(...)` — **llama a la función de la línea 549**. Es el ejemplo de quién dispara un mail |
| FreeWheel / `src/bookings/bookings.service.ts` | 1174 | `safeNotify` — envuelve esas llamadas para que, si el mail falla, la reserva siga igual |

---

## 3. La app en cinco idiomas

**Abrir:** `Fw / src/i18n/core.js`
**Mostrar:** pasos 1 a 8 — líneas **21, 29, 38, 40, 52, 54, 64 y 76**

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| Fw / `src/i18n/index.jsx` | 37 | `useState(idiomaInicial)` — **llama a `idiomaInicial()` de la línea 64**: el idioma guardado entra al estado de React |
| Fw / `src/i18n/index.jsx` | 47 | `setLang` — antes de cambiar comprueba contra `DICTIONARIES` (línea 38), así un idioma que no existe no rompe nada |
| Fw / `src/components/LangPicker.jsx` | 103 | `setLang(l.code)` — el botón usa ese mismo `setLang` del proveedor |

---

## 4. Precios en la moneda que elija el usuario

**Abrir:** `Fw / src/services/moneda.js`
**Mostrar:** pasos 1 a 9 — líneas **47, 90, 109, 115, 127, 132, 137, 164 y 171**

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| Fw / `src/context/CurrencyContext.jsx` | 41 | `traerTasas()` — **llama a la línea 109**, una sola vez al abrir la app |
| Fw / `src/context/CurrencyContext.jsx` | 54 | `precio: (pesos) => formatearPrecio(...)` — **envuelve la línea 164** y es lo que usan todas las pantallas |
| Fw / `src/components/CurrencyPicker.jsx` | 88 | `setMoneda(m.code)` — el botón cambia la moneda del contexto, y todo lo que use `precio()` se redibuja |

---

## 5. Modo oscuro en toda la app

**Abrir:** `Fw / src/services/theme.js`
**Mostrar:** pasos 1 a 9 — líneas **47, 50, 120, 123, 222, 228, 230, 625 y 639**

La idea en una frase: los colores son **variables de CSS**, y el botón solo
pone o saca la clase `fw-dark` del `<html>`.

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| Fw / `src/pages/Settings/Settings.jsx` | 93 | `applyDarkMode(v)` — **llama a la línea 625**. Antes guarda la preferencia en `fw_prefs` |
| Fw / `src/App.jsx` | 78 | `initTheme()` — **llama a la línea 639** al abrir la app, para que el tema guardado se aplique solo |
| Fw / `src/components/Layout.jsx` | 749 | `background: "var(--fw-surface)"` — **usa la variable que definen las líneas 50 y 123**. Ningún componente escribe un color fijo: por eso cambia todo de una |

---

## 6. Diseño adaptado al celular

**Abrir:** `Fw / src/hooks/useIsMobile.js`
**Mostrar:** pasos 1 a 7 — líneas **13, 15, 17, 24, 29, 32 y 36**

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| Fw / `src/components/Layout.jsx` | 526 | `{isMobile ? (` — **usa el valor que devuelve la línea 36**: en celular la barra lateral pasa a ser un menú |
| Fw / `src/styles/theme.css` | 442 | `@media (max-width: 767px)` — **el mismo corte de 768 de la línea 15**, pero del lado del CSS |
| Fw / `index.html` | 8 | la etiqueta `viewport`: sin ella el teléfono miente el ancho y no funcionaría ninguno de los dos |

---

# Sprint 6

## 7. Modo lectura para personas con dislexia

**Abrir:** `Fw / src/services/theme.js`
**Mostrar:** pasos 1 a 6 — líneas **616, 528, 534, 553, 581 y 334**

Mismo mecanismo que el modo oscuro: una clase en el `<html>`, acá `fw-lectura`.

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| Fw / `src/pages/Settings/Settings.jsx` | 95 | `applyReadableFont(v)` — **llama a la línea 616** |
| `public/fuentes/` | — | ahí vive el archivo de OpenDyslexic que carga el `@font-face` de la línea 534. Viene con la app: no se baja de ningún lado |

---

## 8. Colores para personas con daltonismo

**Abrir:** `Fw / src/services/theme.js`
**Mostrar:** pasos 1 a 6 — líneas **607, 376, 381, 387, 431 y 433**

Lo que conviene remarcar: **no cambia todos los colores, solo los que se
confunden**, y las líneas 431 y 433 son las que hacen que funcione también con
el modo oscuro prendido al mismo tiempo.

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| Fw / `src/pages/Settings/Settings.jsx` | 97 | `applyColorBlindMode(v)` — **llama a la línea 607** |
| Fw / `src/services/theme.js` | 50 y 123 | las variables que se pisan son las mismas del modo claro y del oscuro: por eso los tres modos se combinan sin estorbarse |

---

## 9. Límites contra bots y cupos diarios

**Abrir:** `FreeWheel / src/common/rate-limit/sensitive-rate-limit.guard.ts`
**Mostrar:** pasos 1 a 9 — líneas **50, 52, 60, 68, 78, 85, 90, 109 y 119**

La frase para arrancar: **un tope en el navegador no es un tope** — se saltea
con F12. Por eso el contador vive en la base de datos del servidor.

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| FreeWheel / `src/common/rate-limit/sensitive-rate-limit.decorator.ts` | 29 | `@SensitiveRateLimit({...})` — **deja la metadata que lee la línea 52** del guard |
| FreeWheel / `src/common/rate-limit/rate-limit.service.ts` | 99 | `hit(...)` — **es lo que llama la línea 68**: suma el pedido en la tabla `RateLimitBucket` con una sola consulta |
| FreeWheel / `src/ai/ai.controller.ts` | 99 | ejemplo de ruta con cupo: `ai.chat`, 80 preguntas a Wili por día |
| FreeWheel / `src/media/media.controller.ts` | 31 | otro: `media.sign`, 100 fotos por día |
| FreeWheel / `src/app.module.ts` | 51 | el límite general, 120 pedidos por minuto por IP |
| FreeWheel / `src/app.module.ts` | 41 | `APP_GUARD` — lo aplica a **todas** las rutas |
| FreeWheel / `src/common/rate-limit/client-ip-throttler.guard.ts` | 14 | cuenta por la IP real y no por la del proxy de Vercel, que sería una sola para todos |
| FreeWheel / `src/antifraude/limites.ts` | 89 | otro tipo de tope: 6 autos por día, 15 por semana |
| FreeWheel / `src/antifraude/antifraude.service.ts` | 101 | `assertPuedePublicar` — cuenta cuántos publicó hoy |
| FreeWheel / `src/listings/listings.service.ts` | 125 | **la línea que lo engancha**: se llama antes de crear la publicación, no después |

---

## 10. Pruebas automáticas y corrección de errores

**Abrir:** `FreeWheel / src/common/utils/cuil.util.spec.ts`
**Mostrar:** pasos 1 a 5 — líneas **13, 15, 17, 23 y 25**

`describe` agrupa, cada `it` es un caso escrito como una frase, y `expect` dice
qué tiene que devolver. Se prueban los casos buenos **y** los de error.

### Enganchados con este archivo

| Archivo | Línea | Qué los une |
|---|---|---|
| FreeWheel / `src/common/utils/cuil.util.ts` | 25 | `cuilChecksumValid` — **es la función que esas pruebas ejercitan** |

### El error corregido

| Archivo | Línea | Qué pasaba |
|---|---|---|
| Fw / `src/pages/Admin/Admin.jsx` | 184 | la pantalla quedaba en blanco si el rol cambiaba con el panel abierto. El comentario largo de abajo explica por qué la comprobación tiene que ir después de todos los hooks y no antes |

---

## Si preguntan por los números

| | Front (Fw) | Back (FreeWheel) |
|---|---|---|
| Pruebas automáticas | 510 | 578 en 47 suites |
| Idiomas | 1626 claves × 5 | — |
| Comentarios de esta guía | 67 | 66 |
