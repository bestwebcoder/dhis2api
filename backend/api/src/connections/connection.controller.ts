import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import {
  CreateConnectionSchema,
  ReassignOwnerSchema,
  type AuthUser,
  type CreateConnectionInput,
  type ReassignOwnerInput,
  UpdateConnectionSchema,
  type UpdateConnectionInput
} from "@dhis-sync/contracts";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { Caller } from "../common/caller.decorator.js";
import type { AccessScope } from "../common/access-scope.js";
import { Roles } from "../auth/roles.decorator.js";
import { ConnectionService } from "./connection.service.js";

function parseConnection(body: unknown): CreateConnectionInput {
  const parsed = CreateConnectionSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    );
  }
  return parsed.data;
}

function parseOwner(body: unknown): ReassignOwnerInput {
  const parsed = ReassignOwnerSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`));
  return parsed.data;
}

function parseUpdate(body: unknown): UpdateConnectionInput {
  const parsed = UpdateConnectionSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`));
  return parsed.data;
}

@Controller("connections")
export class ConnectionController {
  constructor(@Inject(ConnectionService) private readonly connections: ConnectionService) {}

  @Get()
  list(@Caller() scope: AccessScope) {
    return this.connections.list(scope);
  }

  @Post("test")
  @HttpCode(200)
  testUnsaved(@Body() body: unknown) {
    return this.connections.testUnsaved(parseConnection(body));
  }

  @Post()
  create(@Caller() scope: AccessScope, @Body() body: unknown) {
    return this.connections.create(parseConnection(body), scope);
  }

  @Put(":id")
  update(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.connections.update(id, parseUpdate(body), scope);
  }

  @Post(":id/test")
  @HttpCode(200)
  testSaved(@Caller() scope: AccessScope, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.connections.testSaved(id, scope);
  }

  // only an administrator decides which client an endpoint belongs to
  @Roles("admin")
  @Put(":id/owner")
  reassignOwner(@CurrentUser() actor: AuthUser, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.connections.reassignOwner(id, parseOwner(body).ownerId, actor);
  }

  @Roles("admin")
  @Delete(":id")
  delete(
    @Caller() scope: AccessScope,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: unknown
  ) {
    return this.connections.delete(id, confirmation, scope);
  }
}
