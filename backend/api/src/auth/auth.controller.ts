import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import {
  GoogleAuthSchema,
  SignInSchema,
  SignUpSchema,
  type AuthUser,
  type GoogleAuthInput,
  type SignInInput,
  type SignUpInput
} from "@dhis-sync/contracts";
import { AuthService } from "./auth.service.js";
import { CurrentUser } from "./current-user.decorator.js";
import { Public } from "./public.decorator.js";

function parseSignUp(body: unknown): SignUpInput {
  const parsed = SignUpSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`));
  return parsed.data;
}

function parseSignIn(body: unknown): SignInInput {
  const parsed = SignInSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`));
  return parsed.data;
}

function parseGoogle(body: unknown): GoogleAuthInput {
  const parsed = GoogleAuthSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`));
  return parsed.data;
}

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post("register")
  register(@Body() body: unknown) {
    return this.auth.register(parseSignUp(body));
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.auth.login(parseSignIn(body));
  }

  /** Signs in, or signs up, with a Google authorization code. */
  @Public()
  @Post("google")
  @HttpCode(200)
  google(@Body() body: unknown) {
    return this.auth.signInWithGoogle(parseGoogle(body));
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
