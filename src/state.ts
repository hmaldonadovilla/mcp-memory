// Bind immutable ownership/provenance at persistence, and keep vectors solely in the native index.
import { randomUUID } from "node:crypto";
import type { Document } from "mongodb";
import { factRef, MemoryError, snapshotSchema } from "./model.js";
import type { Snapshot } from "./model.js";
import type { Actor } from "./access.js";

export function readState(document: Document): Snapshot {
  const state = snapshotSchema.parse({
    schemaVersion: document.schemaVersion,
    revision: document.revision,
    entities: document.entities,
    relations: document.relations,
    ...(document.profile ? { profile: document.profile } : {}),
  });
  for (const entity of state.entities)
    for (const fact of entity.facts) {
      if (!fact.permissions)
        throw new MemoryError(
          "migration_required",
          "Existing facts need a reviewed ownership migration before use.",
        );
      fact.ref = factRef(String(document._id), fact.id, fact.permissions);
    }
  return state;
}

export function bindState(
  next: Snapshot,
  previous: Snapshot | undefined,
  who: Actor,
  permissionChange = false,
): Snapshot {
  const state = snapshotSchema.parse(next);
  const existing = new Map(
    previous?.entities.flatMap((entity) =>
      entity.facts.map((fact) => [fact.id, fact] as const),
    ),
  );
  for (const entity of state.entities)
    for (const fact of entity.facts) {
      const old = existing.get(fact.id);
      if (old) {
        if (!old.permissions || old.permissions.creator_user_id !== who.user_id)
          throw new MemoryError(
            "permission_denied",
            "Only the creator may modify a memory.",
          );
        const expected = permissionChange
          ? {
              ...fact.permissions,
              visibility: old.permissions.visibility,
              team_ids: old.permissions.team_ids,
              revision: old.permissions.revision,
            }
          : fact.permissions;
        if (JSON.stringify(expected) !== JSON.stringify(old.permissions))
          throw new MemoryError(
            "permission_denied",
            "Memory ownership and provenance are immutable; use the permissions tool for sharing.",
          );
      } else {
        if (fact.permissions)
          throw new MemoryError(
            "permission_denied",
            "New memories cannot supply their own identity or permissions.",
          );
        fact.permissions = {
          creator_user_id: who.user_id,
          source_conversation_id: who.conversation_id,
          source_task_id: who.task_id,
          generation: randomUUID(),
          revision: 1,
          visibility: "user",
          team_ids: [],
        };
      }
      delete fact.ref;
    }
  return state;
}

export function withoutVectors(state: Snapshot): Snapshot {
  const persisted = structuredClone(state);
  for (const entity of persisted.entities) {
    delete entity.vector;
    for (const fact of entity.facts) {
      delete fact.vector;
      delete fact.ref;
    }
  }
  return persisted;
}
