import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const userId = (request.user as { id?: string } | undefined)?.id;
    // Method + path + user are safe to log; headers and body are intentionally
    // omitted because they may carry credentials, tokens, or passwords.
    const where = `${request.method} ${request.originalUrl}`;
    const who = userId ? ` user=${userId}` : "";

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const body =
        typeof payload === "string"
          ? { statusCode: status, message: payload }
          : payload;

      // Server errors are unexpected even when modeled as HttpException; log the
      // stack. Client errors (4xx) are routine, so warn without the stack.
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.error(`${where} -> ${status}${who}: ${exception.message}`, exception.stack);
      } else {
        this.logger.warn(`${where} -> ${status}${who}: ${exception.message}`);
      }

      response.status(status).json(body);
      return;
    }

    const error = exception instanceof Error ? exception : undefined;
    this.logger.error(
      `${where} -> 500${who}: ${error?.message ?? "Unknown error"}`,
      error?.stack,
    );

    // Return Nest's default 500 shape so no internal detail leaks to the client.
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "Internal server error",
    });
  }
}
