import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { EventBus } from "../events/bus.ts";
import { WorkspaceService } from "./service.ts";

let tmp: string;
let service: WorkspaceService;
let bus: EventBus;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "console-ws-"));
  const { db } = openDb(":memory:");
  bus = new EventBus(db);
  service = new WorkspaceService(db, bus, [tmp]);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("WorkspaceService", () => {
  it("creates the directory and the row, and emits workspace.created", async () => {
    const target = path.join(tmp, "my-project");
    const ws = await service.create({
      name: "My Project",
      rootPath: target,
      create: true,
    });
    expect(existsSync(target)).toBe(true);
    expect(ws.rootPath).toBe(target);
    expect(service.list().map((w) => w.id)).toEqual([ws.id]);
    expect(bus.headSeq()).toBe(1);
  });

  it("refuses a rootPath outside the allowed roots", async () => {
    await expect(
      service.create({ name: "x", rootPath: "/etc/nope", create: true }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a missing rootPath without create", async () => {
    await expect(
      service.create({ name: "x", rootPath: path.join(tmp, "absent") }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a duplicate rootPath", async () => {
    const target = path.join(tmp, "dup");
    await service.create({ name: "a", rootPath: target, create: true });
    await expect(
      service.create({ name: "b", rootPath: target }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
