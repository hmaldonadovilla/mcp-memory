// MongoDB filters protected facts before any graph/text reaches the MCP process.
import type { Document } from "mongodb";
import type { Actor } from "./access.js";

export function graphBoundary(who: Actor): Document {
  return {
    realm: who.realm,
    tenant_id: who.tenant_id,
    scope_ref: who.scope_ref,
    storage_version: 3,
  };
}

export function graphProjection(
  who: Actor,
  teams: string[],
  names?: string[] | Document,
): Document {
  const own = { $eq: ["$owner_user_id", { $literal: who.user_id }] };
  const permission = {
    $or: [
      own,
      { $eq: ["$$f.permissions.visibility", "global"] },
      {
        $and: [
          { $eq: ["$$f.permissions.visibility", "team"] },
          {
            $gt: [
              {
                $size: {
                  $setIntersection: [
                    { $ifNull: ["$$f.permissions.team_ids", []] },
                    { $literal: teams },
                  ],
                },
              },
              0,
            ],
          },
        ],
      },
    ],
  };
  const facts = {
    $filter: {
      input: "$$e.facts",
      as: "f",
      cond: {
        $and: [
          permission,
          {
            $or: [
              { $eq: [{ $type: "$$f.source.validUntil" }, "missing"] },
              { $gt: ["$$f.source.validUntil", new Date().toISOString()] },
            ],
          },
        ],
      },
    },
  };
  const selected = Array.isArray(names) ? { $literal: names } : names;
  const inputs = names
    ? {
        $filter: {
          input: "$entities",
          as: "e",
          cond: { $in: ["$$e.name", selected] },
        },
      }
    : "$entities";
  const projected = {
    $map: {
      input: inputs,
      as: "e",
      in: {
        name: "$$e.name",
        entityType: "$$e.entityType",
        revision: "$$e.revision",
        subjects: { $cond: [own, "$$e.subjects", []] },
        facts: {
          $map: {
            input: facts,
            as: "f",
            in: {
              id: "$$f.id",
              content: "$$f.content",
              createdAt: "$$f.createdAt",
              source: { $cond: [own, "$$f.source", "$$REMOVE"] },
              permissions: {
                $mergeObjects: [
                  "$$f.permissions",
                  {
                    source_conversation_id: {
                      $cond: [
                        own,
                        "$$f.permissions.source_conversation_id",
                        null,
                      ],
                    },
                    source_task_id: {
                      $cond: [own, "$$f.permissions.source_task_id", null],
                    },
                    team_ids: {
                      $cond: [
                        own,
                        "$$f.permissions.team_ids",
                        {
                          $setIntersection: [
                            { $ifNull: ["$$f.permissions.team_ids", []] },
                            { $literal: teams },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
  return {
    _id: 1,
    schemaVersion: 1,
    revision: 1,
    profile: 1,
    entities: {
      $filter: {
        input: projected,
        as: "e",
        cond: { $or: [own, { $gt: [{ $size: "$$e.facts" }, 0] }] },
      },
    },
    relations: {
      $cond: [
        own,
        names
          ? {
              $filter: {
                input: "$relations",
                as: "r",
                cond: {
                  $and: [
                    { $in: ["$$r.from", selected] },
                    { $in: ["$$r.to", selected] },
                  ],
                },
              },
            }
          : "$relations",
        [],
      ],
    },
  };
}
