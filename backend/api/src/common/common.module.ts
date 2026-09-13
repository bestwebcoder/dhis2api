import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service.js";
import { RunRegistry } from "./run-registry.service.js";

/**
 * Cross-cutting services every feature module may reach for: the audit trail and
 * the registry of in-flight runs. Global so a feature module does not have to
 * import another feature module to answer "is this safe to delete?".
 *
 * `access-scope.ts` and `caller.decorator.ts` live here too, but are plain
 * values rather than providers — a scope is derived per request, not injected.
 */
@Global()
@Module({
  providers: [AuditService, RunRegistry],
  exports: [AuditService, RunRegistry]
})
export class CommonModule {}
