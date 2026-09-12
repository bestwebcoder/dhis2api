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
  exports: [AuthService, TokenService]
})
export class AuthModule {}
