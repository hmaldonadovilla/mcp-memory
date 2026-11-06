// Framework/operator-owned memberships are read on each operation; model input never grants a team.
import { z } from "zod";
import type { Db } from "mongodb";
import { MemoryError } from "./model.js";
import type { Actor, Team } from "./access.js";

const membership = z.object({
  tenant_id: z.string(),
  user_id: z.string(),
  team_id: z.string(),
  status: z.literal("active"),
});
const team = z.object({
  _id: z.string(),
  tenant_id: z.string(),
  name: z.string().min(1).max(120),
  status: z.literal("active"),
});
export async function activeTeams(db: Db, who: Actor): Promise<Team[]> {
  if (who.kind !== "user") return [];
  try {
    const rows = await db
      .collection("memory_team_memberships")
      .find({
        tenant_id: who.tenant_id,
        user_id: who.user_id,
        status: "active",
      })
      .limit(257)
      .toArray();
    if (rows.length > 256) throw Error("membership_bound");
    const ids = rows
      .map((row) => membership.parse(row))
      .map((row) => {
        if (row.tenant_id !== who.tenant_id || row.user_id !== who.user_id)
          throw Error("membership_scope");
        return row.team_id;
      });
    if (!ids.length) return [];
    const matches = await db
      .collection<{
        _id: string;
        tenant_id: string;
        name: string;
        status: string;
      }>("memory_teams")
      .find({
        _id: { $in: ids },
        tenant_id: who.tenant_id,
        status: "active",
      })
      .limit(257)
      .toArray();
    if (matches.length > 256) throw Error("membership_bound");
    return matches
      .map((row) => team.parse(row))
      .map((row) => {
        if (row.tenant_id !== who.tenant_id || !ids.includes(row._id))
          throw Error("team_scope");
        return { team_id: row._id, name: row.name };
      })
      .sort((a, b) => a.team_id.localeCompare(b.team_id));
  } catch {
    throw new MemoryError(
      "directory_unavailable",
      "Current team memberships could not be verified; no stale membership fallback was used.",
    );
  }
}
