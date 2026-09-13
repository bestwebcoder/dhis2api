import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { CreateSyncDefinitionSchema, type CreateSyncDefinitionInput, UpdateSyncDefinitionSchema, type UpdateSyncDefinitionInput, UpsertScheduleSchema, type UpsertScheduleInput } from "@dhis-sync/contracts";
import { Roles } from "../auth/roles.decorator.js";
import { Caller } from "../common/caller.decorator.js";
import type { AccessScope } from "../common/access-scope.js";
import { SyncService } from "./sync.service.js";

function parseCreate(body: unknown): CreateSyncDefinitionInput {
  const result = CreateSyncDefinitionSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

function parseSchedule(body: unknown): UpsertScheduleInput {
  const result = UpsertScheduleSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

function parseUpdate(body: unknown): UpdateSyncDefinitionInput {
  const result = UpdateSyncDefinitionSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

@Controller("sync-definitions")
export class SyncController {
  constructor(@Inject(SyncService) private readonly sync: SyncService) {}

  @Get() list(@Caller() scope: AccessScope) { return this.sync.list(scope); }
  @Post() create(@Caller() scope: AccessScope, @Body() body: unknown) { return this.sync.create(parseCreate(body), scope); }
  @Put(":id") update(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.sync.update(id, parseUpdate(body), scope);
  }
  // a run is a full replace, so it destroys the table's current contents
  @Roles("admin") @Post(":id/run") @HttpCode(200) run(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.sync.run(id, "manual", undefined, scope);
  }
  @Put(":id/schedule") schedule(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.sync.schedule(id, parseSchedule(body), scope);
  }
  @Roles("admin") @Delete(":id/schedule") deleteSchedule(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.sync.deleteSchedule(id, scope);
  }
  @Roles("admin") @Delete(":id/runs") clearRuns(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.sync.clearRuns(id, scope);
  }
  @Roles("admin") @Delete(":id") delete(
    @Caller() scope: AccessScope,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: unknown
  ) {
    return this.sync.delete(id, confirmation, scope);
  }
}
