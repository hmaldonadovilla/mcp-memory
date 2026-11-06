// Caller identity is supplied by a trusted host, never by model/tool arguments.
import { z } from "zod";
import { digest, MemoryError } from "./model.js";

const key = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_:./-]+$/);
export const callerSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("discovery") }),
  z.strictObject({
    mode: z.literal("user"),
    tenant_id: key,
    user_id: key,
    conversation_id: key,
    task_id: key,
    scope_ref: key,
  }),
]);
export type CallerContext = z.infer<typeof callerSchema>;
export interface Actor {
  kind: "user" | "realm";
  realm: string;
  namespace: string;
  tenant_id: string;
  user_id: string;
  scope_ref: string;
  conversation_id: string | null;
  task_id: string | null;
}
export type Visibility = "user" | "team" | "global";
export const changePermissionsSchema = z.strictObject({
  fact_refs: z
    .array(z.string().regex(/^fact:[a-f0-9]{64}:[a-f0-9]{64}$/))
    .min(1)
    .max(64),
  visibility: z.enum(["user", "team", "global"]),
  team_ids: z.array(key).max(64).default([]),
});
export type PermissionChange = z.infer<typeof changePermissionsSchema>;
export interface Team {
  team_id: string;
  name: string;
}

export function actor(realm: string, caller?: CallerContext): Actor {
  if (caller?.mode === "discovery")
    throw new MemoryError(
      "identity_required",
      "Discovery cannot read or change memories.",
    );
  if (!caller)
    return {
      kind: "realm",
      realm,
      namespace: realm,
      tenant_id: "realm:" + digest(realm),
      user_id: "realm:" + digest(realm),
      scope_ref: realm,
      conversation_id: null,
      task_id: null,
    };
  return {
    kind: "user",
    realm,
    namespace: digest(
      JSON.stringify([
        realm,
        caller.tenant_id,
        caller.user_id,
        caller.scope_ref,
      ]),
    ),
    tenant_id: caller.tenant_id,
    user_id: caller.user_id,
    scope_ref: caller.scope_ref,
    conversation_id: caller.conversation_id,
    task_id: caller.task_id,
  };
}

export function aclFilter(who: Actor, teams: string[]) {
  return {
    realm: who.realm,
    tenant_id: who.tenant_id,
    scope_ref: who.scope_ref,
    $or: [
      { owner_user_id: who.user_id },
      { visibility: "global" },
      ...(teams.length
        ? [{ visibility: "team", team_ids: { $in: teams } }]
        : []),
    ],
  };
}
