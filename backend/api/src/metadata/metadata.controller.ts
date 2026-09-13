import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import {
  DiscoverMetadataSchema,
  ResourceTypeSchema,
  type DiscoverMetadataInput
} from "@dhis-sync/contracts";
import { Caller } from "../common/caller.decorator.js";
import type { AccessScope } from "../common/access-scope.js";
import { MetadataService } from "./metadata.service.js";
import { Inject } from "@nestjs/common";

function parseDiscovery(body: unknown): DiscoverMetadataInput {
  const result = DiscoverMetadataSchema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((issue) => issue.message));
  }
  return result.data;
}

@Controller("metadata")
export class MetadataController {
  constructor(@Inject(MetadataService) private readonly metadata: MetadataService) {}

  @Get("connections/:connectionId/resources")
  listResources(
    @Caller() scope: AccessScope,
    @Param("connectionId", new ParseUUIDPipe()) connectionId: string,
    @Query("type") type: string
  ) {
    const resourceType = ResourceTypeSchema.safeParse(type);
    if (!resourceType.success) throw new BadRequestException("type must be program or dataset");
    return this.metadata.listResources(connectionId, resourceType.data, scope);
  }

  @Post("discover")
  @HttpCode(200)
  discover(@Caller() scope: AccessScope, @Body() body: unknown) {
    return this.metadata.discover(parseDiscovery(body), scope);
  }
}

