import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  CONNECTION_ENCRYPTION_KEY: z.string().min(1),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  AUTH_JWT_SECRET: z.string().min(32, "AUTH_JWT_SECRET must be at least 32 characters"),
  AUTH_TOKEN_TTL_HOURS: z.coerce.number().int().positive().max(720).default(12),
  AUTH_ALLOW_SIGNUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true")
});

export type AppConfig = z.infer<typeof EnvironmentSchema>;

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= EnvironmentSchema.parse(process.env);
  return cachedConfig;
}

