// Authorization fixtures cover trusted identity binding, immutable provenance and live team-directory failures.
import { expect, it, vi } from "vitest";
import type { Db } from "mongodb";
import {
  actor,
  aclFilter,
  callerSchema,
  changePermissionsSchema,
} from "../src/access.js";
import { activeTeams } from "../src/directory.js";
import { graphBoundary, graphProjection } from "../src/visibility.js";
import { bindState, readState, withoutVectors } from "../src/state.js";
import { emptySnapshot, factRef, publicEntity } from "../src/model.js";
import type { Snapshot } from "../src/model.js";
const context = {
  mode: "user" as const,
  tenant_id: "tenant",
  user_id: "owner",
  conversation_id: "conversation:1",
  task_id: "task:1",
  scope_ref: "scope",
};
const who = actor("realm", context);
const input: Snapshot = {
  ...emptySnapshot(),
  revision: 1,
  entities: [
    {
      name: "A",
      entityType: "test",
      subjects: [],
      revision: 1,
      vector: [1, 0],
      facts: [
        {
          id: "a".repeat(64),
          content: "private fact",
          createdAt: "2026-01-01T00:00:00Z",
          vector: [1, 0],
        },
      ],
    },
  ],
};
it("binds a stable user namespace without accepting caller-supplied permissions or discovery data access", () => {
  expect(
    actor("realm", { ...context, conversation_id: "conversation:2" }).namespace,
  ).toBe(who.namespace);
  expect(actor("realm", { ...context, user_id: "other" }).namespace).not.toBe(
    who.namespace,
  );
  expect(actor("realm").kind).toBe("realm");
  expect(() => actor("realm", { mode: "discovery" })).toThrow("Discovery");
  expect(
    callerSchema.safeParse({ ...context, visibility: "global" }).success,
  ).toBe(false);
  expect(aclFilter(who, []).$or).toHaveLength(2);
  expect(aclFilter(who, ["team:1"]).$or).toHaveLength(3);
  expect(
    changePermissionsSchema.safeParse({
      fact_refs: ["bad"],
      visibility: "global",
    }).success,
  ).toBe(false);
  expect(graphBoundary(who)).toMatchObject({
    realm: "realm",
    tenant_id: "tenant",
    storage_version: 3,
  });
  for (const names of [undefined, ["$literal"], { $literal: ["A"] }])
    expect(graphProjection(who, [], names)).toHaveProperty("entities");
});
it("stores vectors solely in the index and binds non-spoofable creator and original conversation provenance", () => {
  const bound = bindState(input, undefined, who);
  const permissions = bound.entities[0]!.facts[0]!.permissions!;
  expect(permissions).toMatchObject({
    creator_user_id: "owner",
    source_conversation_id: "conversation:1",
    source_task_id: "task:1",
    visibility: "user",
    team_ids: [],
  });
  const persisted = withoutVectors(bound);
  expect(JSON.stringify(persisted)).not.toContain('"vector"');
  const loaded = readState({ _id: who.namespace, ...persisted });
  expect(publicEntity(loaded.entities[0]!).fact_metadata![0]).toMatchObject({
    ref: factRef(who.namespace, "a".repeat(64), permissions),
    visibility: "user",
  });
  expect(
    bindState(loaded, loaded, who).entities[0]!.facts[0]!.permissions,
  ).toEqual(permissions);
  expect(() => bindState(bound, undefined, who)).toThrow("own identity");
  expect(() => bindState(loaded, loaded, { ...who, user_id: "other" })).toThrow(
    "creator",
  );
  const altered = structuredClone(loaded);
  altered.entities[0]!.facts[0]!.permissions!.source_conversation_id =
    "spoofed";
  expect(() => bindState(altered, loaded, who)).toThrow("immutable");
  const shared = structuredClone(loaded);
  Object.assign(shared.entities[0]!.facts[0]!.permissions!, {
    visibility: "global",
    revision: 2,
  });
  expect(() => bindState(shared, loaded, who)).toThrow("permissions tool");
  expect(
    bindState(shared, loaded, who, true).entities[0]!.facts[0]!.permissions!
      .visibility,
  ).toBe("global");
  expect(() => readState({ _id: who.namespace, ...input })).toThrow(
    "reviewed ownership",
  );
  expect(() => bindState(input, input, who)).toThrow("creator");
});
it("validates active directory rows and refuses stale, malformed, cross-tenant or oversized memberships", async () => {
  const memberships = [
    {
      tenant_id: "tenant",
      user_id: "owner",
      team_id: "team:1",
      status: "active",
    },
  ];
  const teams = [
    { _id: "team:1", tenant_id: "tenant", name: "Team 1", status: "active" },
  ];
  teams.push({
    _id: "team:2",
    tenant_id: "tenant",
    name: "Team 2",
    status: "active",
  });
  memberships.push({
    tenant_id: "tenant",
    user_id: "owner",
    team_id: "team:2",
    status: "active",
  });
  const readMembers = vi.fn(async () => memberships),
    readTeams = vi.fn(async () => teams);
  const db = {
    collection: (name: string) => ({
      find: () => ({
        limit: () => ({
          toArray: name === "memory_teams" ? readTeams : readMembers,
        }),
      }),
    }),
  } as unknown as Db;
  expect(await activeTeams(db, who)).toEqual([
    { team_id: "team:1", name: "Team 1" },
    { team_id: "team:2", name: "Team 2" },
  ]);
  expect(await activeTeams(db, actor("realm"))).toEqual([]);
  readMembers.mockResolvedValueOnce([]);
  expect(await activeTeams(db, who)).toEqual([]);
  for (const values of [
    Array.from({ length: 257 }, () => memberships[0]!),
    [{ ...memberships[0]!, tenant_id: "other" }],
    [{ ...memberships[0]!, user_id: "other" }],
    [{ ...memberships[0]!, status: "inactive" }],
  ]) {
    readMembers.mockResolvedValueOnce(values);
    await expect(activeTeams(db, who)).rejects.toHaveProperty(
      "code",
      "directory_unavailable",
    );
  }
  for (const values of [
    Array.from({ length: 257 }, () => teams[0]!),
    [{ ...teams[0]!, tenant_id: "other" }],
    [{ ...teams[0]!, _id: "unassigned" }],
  ]) {
    readTeams.mockResolvedValueOnce(values);
    await expect(activeTeams(db, who)).rejects.toHaveProperty(
      "code",
      "directory_unavailable",
    );
  }
  readMembers.mockRejectedValueOnce(Error("private driver error"));
  await expect(activeTeams(db, who)).rejects.toHaveProperty(
    "code",
    "directory_unavailable",
  );
});
