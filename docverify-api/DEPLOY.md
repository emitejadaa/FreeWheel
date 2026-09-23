# Poner esta API a correr en un servidor

Esta guía es para **quien administra el servidor**. No hace falta saber Python
ni leer el código: todo entra en un contenedor Docker y se levanta con dos
comandos.

Qué es: un servicio HTTP que recibe fotos de un DNI o de una licencia de
conducir argentinos y devuelve los datos que pudo leer. No tiene base de datos,
no guarda las imágenes y no le pega a ningún otro servicio salvo al callback que
le indique quien llama.

---

## Lo que tiene que tener el servidor

| | Mínimo | Recomendado |
|---|---|---|
| RAM | 2 GB | 4 GB |
| CPU | 1 vCPU | 2 vCPU |
| Disco | 3 GB libres | 5 GB |
| Software | Docker con el plugin `compose` | idem |

**La RAM no es negociable.** Está medido, no estimado: en una instancia de
512 MB un análisis de las dos caras NO TERMINA — el proceso muere a los 2-3
minutos sin dejar traceback. El pico está en la búsqueda de códigos de barras,
que trabaja sobre copias ampliadas de la imagen, así que mandar fotos más chicas
no lo baja.

Comprobar que Docker está y es reciente:

```bash
docker --version          # 20.10 o mayor
docker compose version    # v2 o mayor
```

Si falta, en Debian/Ubuntu: `curl -fsSL https://get.docker.com | sh`.

---

## Paso a paso

### 1 · Traer el código

```bash
git clone https://github.com/emitejadaa/FreeWheel.git
cd FreeWheel/docverify-api
```

Todo lo que sigue se hace **dentro de `docverify-api/`**. El resto del
repositorio es el backend, y no interviene acá.

### 2 · Crear el archivo de configuración

```bash
cp .env.docker.example .env
```

### 3 · Poner el token

Es el único valor obligatorio. Generar uno al azar:

```bash
openssl rand -hex 32
```

y pegarlo en el `.env`:

```bash
DOCVERIFY_TOKEN="el-valor-que-salió-del-comando"
```

Ese token es la única puerta de la API: sin él, cualquiera que sepa la URL
puede mandarle lo que quiera, y por acá pasan documentos de identidad de
personas reales. **Si queda vacío el contenedor no arranca**, a propósito.

Hay que pasárselo a quien vaya a consumir la API (va en cada pedido, en el
header `Authorization: Bearer <token>` o en `X-Docverify-Token`).

### 4 · Elegir cómo se publica

**Opción A — con HTTPS, que Docker resuelve solo.** Es la recomendada si el
servidor no tiene ya un reverse proxy.

Requisitos previos, los dos fuera del contenedor:

- un dominio o subdominio con un registro **A** apuntando a la IP pública del
  servidor (por ejemplo `docverify.tudominio.com`);
- los puertos **80 y 443 abiertos** en el firewall. El 80 no es opcional aunque
  el tráfico real vaya por HTTPS: es por donde Let's Encrypt valida el dominio
  y por donde se renueva el certificado.

En el `.env`:

```bash
DOMINIO=docverify.tudominio.com
```

Y levantar:

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

El certificado se pide, se instala y se renueva solo. No hay certbot ni cron
que configurar.

**Opción B — detrás de un reverse proxy que ya existe** (nginx, Traefik, el
balanceador del proveedor):

```bash
docker compose up -d --build
```

Así la API queda escuchando en `127.0.0.1:8000` del servidor, **sin asomarse a
internet**, y el proxy de ustedes le pasa el tráfico. La configuración de nginx
sería:

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 45M;   # las dos caras en base64
    proxy_read_timeout 600s;    # un análisis puede tardar minutos
}
```

> El primer `--build` baja ~300 MB de dependencias y tarda entre 3 y 10 minutos
> según la conexión. Los siguientes reusan la caché y son de segundos.

### 5 · Comprobar que quedó andando

```bash
docker compose ps
```

Tiene que decir `Up ... (healthy)`. El `healthy` puede tardar hasta 90 segundos
la primera vez: al arrancar, el servicio abre el motor de OCR en segundo plano.

```bash
curl http://127.0.0.1:8000/health
```

La respuesta esperada:

```json
{
  "ok": true,
  "servicio": "docverify-api",
  "ocr_cargado": true,
  "protegido_con_token": true,
  "analisis_en_cola": 0
}
```

Los dos campos que importan:

- **`protegido_con_token: true`** — si dice `false`, el token no se cargó y la
  API está abierta. Revisar el `.env` y volver a levantar.
- **`ocr_cargado: true`** — el motor terminó de cargar. Verlo en `false` recién
  arrancado es normal; en `false` cinco minutos después significa que la carga
  falló, y el motivo está en `docker compose logs api`.

Desde afuera, con la opción A:

```bash
curl https://docverify.tudominio.com/health
```

### 6 · Probar que analiza de verdad

Con cualquier foto de un DNI a mano:

```bash
curl -X POST https://docverify.tudominio.com/analizar/dni-frente \
  -H "Authorization: Bearer EL-TOKEN" \
  -F "imagen=@/ruta/a/la/foto.jpg"
```

Contesta un JSON con `"ok": true` y los campos leídos. Tarda entre 5 y 15
segundos: es normal, el análisis es pesado.

Y que sin token NO deje entrar:

```bash
curl -o /dev/null -w "%{http_code}\n" -X POST \
  https://docverify.tudominio.com/analizar/dni-frente -F "imagen=@/ruta/a/la/foto.jpg"
# tiene que imprimir 401
```

Con eso el deploy está terminado.

---

## Operación de todos los días

```bash
docker compose logs -f api        # ver los logs en vivo
docker compose logs --tail 100 api
docker compose restart api        # reiniciar
docker compose down               # bajar
docker compose up -d              # levantar
docker stats docverify-api        # cuánta memoria está usando
```

**Actualizar a una versión nueva del código:**

```bash
git pull
docker compose up -d --build
```

(Con la opción A, agregar los dos `-f` como en el paso 4.)

El contenedor se reinicia solo si el servidor se reinicia o si el proceso muere
(`restart: unless-stopped`). Si alguien lo baja a mano, se queda abajo.

**Backups: no hay nada que respaldar.** El servicio no guarda estado: ni base de
datos, ni las imágenes que recibe, ni nada en disco. Lo único persistente es el
certificado de HTTPS, en el volumen `caddy_data`, y si se pierde se vuelve a
emitir solo.

---

## Si algo no anda

| Síntoma | Qué pasa |
|---|---|
| `env file .env not found` | Falta el paso 2: `cp .env.docker.example .env`. |
| El contenedor reinicia en bucle y el log dice `DOCVERIFY_TOKEN está vacío` | Falta el paso 3. Es la protección funcionando, no un error. |
| `docker compose ps` dice `unhealthy` | `docker compose logs api`. Casi siempre es memoria: ver la fila siguiente. |
| El contenedor muere solo durante un análisis, sin error | Se quedó sin RAM. `docker stats` mientras corre un análisis lo confirma. Subir la memoria del servidor o el `mem_limit` del `docker-compose.yml`. |
| Todo contesta `401` | El token del pedido no coincide con el del `.env`. Ojo con los espacios y las comillas al copiarlo. |
| Un pedido contesta `503` | La API está saturada: hay más análisis en cola que `DOCVERIFY_COLA_MAXIMA`. La respuesta trae `Retry-After`. |
| Un pedido contesta `413` | La imagen supera `DOCVERIFY_MAX_KB` (15.000 KB por default). |
| Caddy no consigue el certificado | El dominio no apunta a este servidor todavía, o el puerto 80 está cerrado. `docker compose logs proxy` lo dice. |
| `docker compose logs proxy` repite `wrong argument count ... 'email'` | Se descomentó el bloque `email` del `Caddyfile` con `ACME_EMAIL` vacío. O se completa la variable, o se vuelve a comentar. |

---

## Sin build en el servidor

Si el servidor no puede construir la imagen (sin salida a internet, política de
la empresa), se construye en otra máquina y se manda la imagen ya hecha:

```bash
# En una máquina con Docker y salida a internet
docker build -t docverify-api:1.0.0 .
docker save docverify-api:1.0.0 | gzip > docverify-api-1.0.0.tar.gz

# En el servidor, con el archivo ya copiado
gunzip -c docverify-api-1.0.0.tar.gz | docker load
docker compose up -d --no-build
```

El `--no-build` es lo que hace que use la imagen cargada en vez de intentar
construirla.

---

## Qué expone la API

Todos los endpoints de análisis piden el token. `/health` y `/contrato` no.

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/health` | Si está vivo y con qué cuenta. |
| GET | `/contrato` | Qué campos devuelve cada documento. |
| GET | `/docs` | Documentación interactiva, en el navegador. |
| POST | `/analizar/documento` | Las dos caras juntas. Contesta 202 y avisa al callback. |
| POST | `/analizar/dni-frente` | Una cara suelta. |
| POST | `/analizar/dni-dorso` | Una cara suelta. |
| POST | `/analizar/licencia-frente` | Una cara suelta. |
| POST | `/analizar/licencia-dorso` | Una cara suelta. |

El detalle de cada uno, con ejemplos de la respuesta, está en el `README.md` de
esta misma carpeta.

---

## Lo que ya viene resuelto en la imagen

Para que no haya que auditarlo: esto es lo que el contenedor hace por su cuenta.

- **No corre como root.** El proceso abre imágenes de gente de afuera con
  OpenCV y un decodificador de códigos de barras; si alguna de esas bibliotecas
  tuviera un agujero, lo tendría como usuario común.
- **Se niega a arrancar sin token** cuando está publicado.
- **CORS cerrado** por default: solo se abre si se listan orígenes a mano.
- **El log tiene techo** (30 MB): no puede llenar el disco.
- **Límite de memoria** de 3 GB por contenedor: un pedido raro no se lleva
  puesto al resto del servidor.
- **Healthcheck propio**: `docker ps` distingue "levantado" de "funcionando",
  que en este servicio no es lo mismo.
- **Tope de tamaño** de imagen, de pedidos en cola y de análisis simultáneos:
  la API contesta 413 o 503 antes de ahogarse.
- **Nada se escribe en disco** en runtime. Las imágenes viven en memoria
  mientras dura el análisis y se descartan.
