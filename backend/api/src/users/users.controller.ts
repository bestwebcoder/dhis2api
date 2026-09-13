import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import {
  ChangePasswordSchema,
  CreateUserSchema,
  UpdateProfileSchema,
  UpdateUserSchema,
  type AuthUser,
  type ChangePasswordInput,
  type CreateUserInput,
  type UpdateProfileInput,
  type UpdateUserInput
} from "@dhis-sync/contracts";
import type { ZodType } from "zod";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { Roles } from "../auth/roles.decorator.js";
import { UsersService } from "./users.service.js";

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`));
  }
  return result.data;
}

@Controller("users")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  // ── self service: any signed-in account, limited to its own row ──────────
  @Put("me/profile")
  updateOwnProfile(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.users.updateOwnProfile(user, parse<UpdateProfileInput>(UpdateProfileSchema, body));
  }

  @Post("me/password")
  @HttpCode(200)
  changeOwnPassword(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.users.changeOwnPassword(user, parse<ChangePasswordInput>(ChangePasswordSchema, body));
  }

  // ── administration: managing other people's access ───────────────────────
  @Roles("admin")
  @Get()
  list() {
    return this.users.list();
  }

  @Roles("admin")
  @Get(":id")
  find(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.users.find(id);
  }

  @Roles("admin")
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown) {
    return this.users.create(parse<CreateUserInput>(CreateUserSchema, body), actor);
  }

  @Roles("admin")
  @Put(":id")
  update(@CurrentUser() actor: AuthUser, @Param("id", new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    return this.users.update(id, parse<UpdateUserInput>(UpdateUserSchema, body), actor);
  }

  @Roles("admin")
  @Delete(":id")
  remove(
    @CurrentUser() actor: AuthUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("confirm") confirmation: unknown
  ) {
    return this.users.remove(id, confirmation, actor);
  }
}
