# render-hosting-control

Controla Render con la CLI oficial desde scripts npm del proyecto.

Variables:

```env
RENDER_API_URL="https://tu-api.onrender.com"
RENDER_SERVICE_ID="srv_..."
RENDER_API_KEY="rnd_..."
RENDER_CLI_PATH=""
RENDER_LOG_LIMIT=100
RENDER_WORKSPACE_ID=""
```

Comandos:

```bash
npm run render:validate
npm run render:deploy
npm run render:deploy:no-wait
npm run render:deploys
npm run render:logs
npm run verify:render
```

Despues de un deploy, validar:

```bash
FRONTEND_URL="https://tu-front.vercel.app" API_BASE_URL="https://tu-api.onrender.com" npm run test:functional
```

No commitear `RENDER_API_KEY`, secretos, `DATABASE_URL` ni `JWT_SECRET`.
