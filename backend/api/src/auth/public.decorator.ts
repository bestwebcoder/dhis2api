import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "auth:isPublic";

/** Opts a route out of the global AuthGuard. Only sign-in, sign-up and health may use it. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
