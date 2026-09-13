import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Caller } from "../common/caller.decorator.js";
import type { AccessScope } from "../common/access-scope.js";
import { ReportService } from "./report.service.js";

@Controller("reports")
export class ReportController {
  constructor(@Inject(ReportService) private readonly reports: ReportService) {}

  @Get() list(@Caller() scope: AccessScope) { return this.reports.list(scope); }

  @Get(":id/data")
  data(
    @Caller() scope: AccessScope,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, string | undefined>
  ) {
    return this.reports.data(id, query, scope);
  }

  @Get(":id/export.csv")
  async csv(
    @Caller() scope: AccessScope,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) response: FastifyReply
  ) {
    const result = await this.reports.csv(id, query, scope);
    response.header("Content-Type", "text/csv; charset=utf-8");
    response.header("Content-Disposition", `attachment; filename="${result.filename}"`);
    return result.content;
  }
}
