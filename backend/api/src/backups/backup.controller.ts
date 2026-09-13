import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { Caller } from "../common/caller.decorator.js";
import type { AccessScope } from "../common/access-scope.js";
import { BackupService } from "./backup.service.js";

function sendJson(response: FastifyReply, result: { filename: string; payload: unknown }) {
  response.header("Content-Type", "application/json; charset=utf-8");
  response.header("Content-Disposition", `attachment; filename="${result.filename}"`);
  return result.payload;
}

function sendCsv(response: FastifyReply, result: { filename: string; content: string }) {
  response.header("Content-Type", "text/csv; charset=utf-8");
  response.header("Content-Disposition", `attachment; filename="${result.filename}"`);
  return result.content;
}

@Controller("backups")
export class BackupController {
  constructor(@Inject(BackupService) private readonly backups: BackupService) {}

  @Get("configuration.json")
  async configuration(@Caller() scope: AccessScope, @Res({ passthrough: true }) response: FastifyReply) {
    return sendJson(response, await this.backups.configuration(scope));
  }

  @Get(":id/data.json")
  async data(
    @Caller() scope: AccessScope,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("year") year: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply
  ) {
    return sendJson(response, await this.backups.data(id, scope, year));
  }

  @Get(":id/data.csv")
  async csv(
    @Caller() scope: AccessScope,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("year") year: string | undefined,
    @Res({ passthrough: true }) response: FastifyReply
  ) {
    return sendCsv(response, await this.backups.csv(id, scope, year));
  }

  @Get(":id/years")
  years(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.backups.years(id, scope);
  }
}
