import { Controller, Get, Inject } from "@nestjs/common";
import { Public } from "./auth/public.decorator.js";
import { DatabaseService } from "./database/database.service.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Public()
  @Get()
  async health() {
    await this.database.query("SELECT 1");
    return { status: "ok", service: "dhis-sync-api", timestamp: new Date().toISOString() };
  }
}
