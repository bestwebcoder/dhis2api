import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller.js";
import { UsersService } from "./users.service.js";

/**
 * Account administration. The users table itself belongs to AuthModule's
 * UserRepository — one repository per table — which AuthModule exports because
 * it is @Global.
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService]
})
export class UsersModule {}
