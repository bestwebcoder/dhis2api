import { Controller, Get, Inject } from "@nestjs/common";
import { Caller } from "../common/caller.decorator.js";
import type { AccessScope } from "../common/access-scope.js";
import { DashboardService } from "./dashboard.service.js";

/**
 * One route, a different answer per account: the view is built from the caller's
 * role and from what they own. No @Roles — a client is meant to reach it, and
 * every query behind it is filtered to what that client owns.
 */
@Controller("dashboard")
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get()
  view(@Caller() scope: AccessScope) {
    return this.dashboard.viewFor(scope);
  }
}
