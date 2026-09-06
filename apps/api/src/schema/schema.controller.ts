import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { GenerateBlueprintSchema, type GenerateBlueprintInput } from "@dhis-sync/contracts";
import { SchemaService } from "./schema.service.js";

function parseGenerate(body: unknown): GenerateBlueprintInput {
  const result = GenerateBlueprintSchema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  return result.data;
}

@Controller("schema-blueprints")
export class SchemaController {
  constructor(@Inject(SchemaService) private readonly schemas: SchemaService) {}

  @Get()
  list() {
    return this.schemas.list();
  }

  @Post()
  generate(@Body() body: unknown) {
    return this.schemas.generate(parseGenerate(body));
  }

  @Post(":id/apply")
  @HttpCode(200)
  apply(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.schemas.apply(id);
  }

  @Delete(":id/table")
  dropTable(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: string,
    @Query("cascade") cascade: string | undefined
  ) {
    return this.schemas.dropTable(id, confirmation, cascade === "true");
  }

  @Delete(":id/blueprint")
  deleteBlueprint(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: string
  ) {
    return this.schemas.deleteBlueprint(id, confirmation);
  }
}
