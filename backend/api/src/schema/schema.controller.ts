import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { GenerateBlueprintSchema, type GenerateBlueprintInput, UpdateBlueprintSchema, type UpdateBlueprintInput } from "@dhis-sync/contracts";
import { Roles } from "../auth/roles.decorator.js";
import { Caller } from "../common/caller.decorator.js";
import type { AccessScope } from "../common/access-scope.js";
import { SchemaService } from "./schema.service.js";

function parseGenerate(body: unknown): GenerateBlueprintInput {
  const result = GenerateBlueprintSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

function parseUpdate(body: unknown): UpdateBlueprintInput {
  const result = UpdateBlueprintSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

@Controller("schema-blueprints")
export class SchemaController {
  constructor(@Inject(SchemaService) private readonly schemas: SchemaService) {}

  @Get()
  list(@Caller() scope: AccessScope) {
    return this.schemas.list(scope);
  }

  @Post()
  generate(@Caller() scope: AccessScope, @Body() body: unknown) {
    return this.schemas.generate(parseGenerate(body), scope);
  }

  @Post(":id/apply")
  @HttpCode(200)
  apply(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.schemas.apply(id, scope);
  }

  @Put(":id")
  update(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.schemas.update(id, parseUpdate(body), scope);
  }

  @Roles("admin")
  @Delete(":id/table")
  dropTable(
    @Caller() scope: AccessScope,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: unknown,
    @Query("cascade") cascade: string | undefined
  ) {
    return this.schemas.dropTable(id, confirmation, cascade === "true", scope);
  }

  @Roles("admin")
  @Delete(":id/blueprint")
  deleteBlueprint(
    @Caller() scope: AccessScope,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: unknown
  ) {
    return this.schemas.deleteBlueprint(id, confirmation, scope);
  }
}
