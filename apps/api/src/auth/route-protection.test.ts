import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { RequestMethod } from "@nestjs/common";
import { ConnectionController } from "../connections/connection.controller.js";
import { ReportController } from "../reports/report.controller.js";
import { SchemaController } from "../schema/schema.controller.js";
import { SyncController } from "../sync/sync.controller.js";
import { BackupController } from "../backups/backup.controller.js";
import { MetadataController } from "../metadata/metadata.controller.js";
import { HealthController } from "../health.controller.js";
import { AuthController } from "./auth.controller.js";
import { IS_PUBLIC } from "./public.decorator.js";
import { REQUIRED_ROLES } from "./roles.decorator.js";

const controllers = [
  ConnectionController, SchemaController, SyncController, ReportController,
  BackupController, MetadataController, AuthController, HealthController
] as const;

interface Route { controller: string; handler: string; method: RequestMethod; roles: string[] | undefined; isPublic: boolean }

function routes(): Route[] {
  const found: Route[] = [];
  for (const controller of controllers) {
    const prototype: object = controller.prototype;
    for (const handler of Object.getOwnPropertyNames(prototype)) {
      if (handler === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, handler);
      if (typeof descriptor?.value !== "function") continue;
      const method = Reflect.getMetadata("method", descriptor.value) as RequestMethod | undefined;
      if (method === undefined) continue;
      found.push({
        controller: controller.name,
        handler,
        method,
        roles: Reflect.getMetadata(REQUIRED_ROLES, descriptor.value) as string[] | undefined,
        isPublic: Reflect.getMetadata(IS_PUBLIC, descriptor.value) === true
      });
    }
  }
  return found;
}

const describeRoute = (route: Route) => `${route.controller}.${route.handler}`;

describe("route protection", () => {
  it("finds the routes it means to check", () => {
    expect(routes().length).toBeGreaterThan(15);
  });

  it("reserves every DELETE route for admins", () => {
    const unguarded = routes()
      .filter((route) => route.method === RequestMethod.DELETE && !route.roles?.includes("admin"))
      .map(describeRoute);
    expect(unguarded).toEqual([]);
  });

  it("reserves the manual sync run for admins, because a run replaces the whole table", () => {
    const run = routes().find((route) => route.controller === "SyncController" && route.handler === "run");
    expect(run?.roles).toEqual(["admin"]);
  });

  it("keeps only sign-in, sign-up and health public", () => {
    expect(routes().filter((route) => route.isPublic).map(describeRoute).sort())
      .toEqual(["AuthController.login", "AuthController.register", "HealthController.health"]);
  });

  it("never marks a route both public and role-restricted", () => {
    expect(routes().filter((route) => route.isPublic && route.roles?.length).map(describeRoute)).toEqual([]);
  });
});
