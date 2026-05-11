import { createServer } from './app.factory';

async function bootstrap() {
  const server = createServer();
  const port = process.env.PORT ?? 3000;

  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

bootstrap();
