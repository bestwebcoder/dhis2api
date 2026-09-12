import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { RolesGuard } from "./auth/roles.guard.js";
import { ConnectionModule } from "./connections/connection.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { MetadataModule } from "./metadata/metadata.module.js";
import { SchemaModule } from "./schema/schema.module.js";
import { SyncModule } from "./sync/sync.module.js";
import { ReportModule } from "./reports/report.module.js";
import { BackupModule } from "./backups/backup.module.js";

@Module({
  imports: [DatabaseModule, AuthModule, ConnectionModule, MetadataModule, SchemaModule, SyncModule, ReportModule, BackupModule],
  controllers: [HealthController],
  // order matters: AuthGuard resolves request.user, then RolesGuard reads its role
  providers: [
    // every route is closed unless it carries @Public()
    { provide: APP_GUARD, useClass: AuthGuard },
    // ...and destructive routes additionally opt into @Roles("admin")
    { provide: APP_GUARD, useClass: RolesGuard }
  ]
})
export class AppModule {}
