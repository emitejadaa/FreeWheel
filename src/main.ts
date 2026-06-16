import { Logger } from "@nestjs/common";
import { createServer } from "./app.factory";

function bootstrap() {
  const logger = new Logger("Bootstrap");
  const server = createServer();
  const port = process.env.PORT ?? 3000;

  server.listen(port, () => {
    const env = process.env.NODE_ENV ?? "development";
    logger.log(`FreeWheel API listening on port ${port}`);
    logger.log(`Environment: ${env} | Node: ${process.version}`);
  });
}

bootstrap();
