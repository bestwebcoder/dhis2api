import { Global, Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";
import { UserRepository } from "./user.repository.js";

@Global()
@Module({
  controllers: [AuthController],
  providers: [UserRepository, PasswordService, TokenService, AuthService],
  // UserRepository and PasswordService are exported for UsersModule: the users
  // table has one repository, and account administration reuses it.
  exports: [AuthService, TokenService, UserRepository, PasswordService]
})
export class AuthModule {}
