import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { CreateSyncDefinitionSchema, type CreateSyncDefinitionInput, UpdateSyncDefinitionSchema, type UpdateSyncDefinitionInput, UpsertScheduleSchema, type UpsertScheduleInput } from "@dhis-sync/contracts";
import { Roles } from "../auth/roles.decorator.js";
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

  @Get() list() { return this.sync.list(); }
  @Post() create(@Body() body: unknown) { return this.sync.create(parseCreate(body)); }
  @Put(":id") update(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) { return this.sync.update(id, parseUpdate(body)); }
  // a run is a full replace, so it destroys the table's current contents
  @Roles("admin") @Post(":id/run") @HttpCode(200) run(@Param("id", new ParseUUIDPipe()) id: string) { return this.sync.run(id); }
  @Put(":id/schedule") schedule(@Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.sync.schedule(id, parseSchedule(body));
  }
  @Roles("admin") @Delete(":id/schedule") deleteSchedule(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.sync.deleteSchedule(id);
  }
  @Roles("admin") @Delete(":id/runs") clearRuns(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.sync.clearRuns(id);
  }
  @Roles("admin") @Delete(":id") delete(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: string
  ) {
    return this.sync.delete(id, confirmation);
  }
}
