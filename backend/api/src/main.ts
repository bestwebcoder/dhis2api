import "reflect-metadata";
import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { getConfig } from "./config.js";

// backend/.env — the frontend has its own, and neither side can read the other's.
// Absent in production (Fly injects secrets as real environment variables), where
// dotenv simply finds no file and leaves process.env alone.
loadEnvironment({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

async function bootstrap(): Promise<void> {
  const config = getConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: config.NODE_ENV !== "test" })
  );
  app.setGlobalPrefix("api/v1");
  const localOrigins = new Set([
    config.WEB_ORIGIN,
    `http://localhost:5173`,
    `http://127.0.0.1:5173`
  ]);
  app.enableCors({
    origin: [...localOrigins],
    credentials: true,
    // @fastify/cors defaults to GET,HEAD,POST — unlike the Express `cors`
    // package Nest's docs assume — so without this every PUT and DELETE from a
    // browser fails its preflight, which is every edit and every deletion.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    exposedHeaders: ["Content-Disposition"]
  });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, "0.0.0.0");
  Logger.log(`API listening on http://localhost:${config.API_PORT}/api/v1`, "Bootstrap");
}

void bootstrap();
