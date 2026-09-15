import { Global, Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { GoogleOAuthService } from "./google-oauth.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";
import { UserRepository } from "./user.repository.js";

@Global()
@Module({
  controllers: [AuthController],
  providers: [UserRepository, PasswordService, TokenService, GoogleOAuthService, AuthService],
  // UserRepository, PasswordService and GoogleOAuthService are exported for
  // UsersModule: the users table has one repository, and account self-service
  // reuses the same credential checks sign-in does.
  exports: [AuthService, TokenService, UserRepository, PasswordService, GoogleOAuthService]
})
export class AuthModule {}
