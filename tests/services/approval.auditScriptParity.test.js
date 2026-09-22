// The audit script's entity->resource map must match the engine's.
//
// scripts/audit_approval_rbac_coherence.sql re-implements
// ENTITY_APPROVE_RESOURCE_MAP as a SQL VALUES list so it can answer "which
// policies resolve to nobody" without running the app. Two copies of the same
// table drift, and this one had: the script mapped MR -> 'awarding' while the
// engine maps MR -> 'mr'. An audit that scores a role against the wrong
// resource reports the wrong answer with total confidence, which is worse than
// not running it — the whole point of the script is to be believed.
//
// Caught while investigating RFQ 536602, where the same audit had reported
// policy 83 as healthy (it only ever checked the permission gate, never
// whether anyone actually held the role in the entity's department).

import { describe, it, expect } from "@jest/globals";
import fs from "fs";
import path from "path";
import { ENTITY_APPROVE_RESOURCE_MAP } from "../../app/models/generalModel.js";

const SCRIPT = path.resolve(process.cwd(), "scripts/audit_approval_rbac_coherence.sql");

/** Pull every ('ENTITY','resource') pair out of the script's VALUES blocks. */
const parseScriptMap = () => {
  const sql = fs.readFileSync(SCRIPT, "utf8");
  const pairs = {};
  for (const [, entity, resource] of sql.matchAll(/\(\s*'([A-Z_]+)'\s*,\s*'([a-z-]+)'\s*\)/g)) {
    pairs[entity] = resource;
  }
  return pairs;
};

describe("audit script / engine resource-map parity", () => {
  it("maps every entity type the engine knows about", () => {
    const script = parseScriptMap();
    const missing = Object.keys(ENTITY_APPROVE_RESOURCE_MAP).filter((k) => !(k in script));
    expect(missing).toEqual([]);
  });

  it("agrees with the engine on every resource", () => {
    const script = parseScriptMap();
    const disagreements = Object.entries(ENTITY_APPROVE_RESOURCE_MAP)
      .filter(([entity, resource]) => script[entity] && script[entity] !== resource)
      .map(([entity, resource]) => `${entity}: script=${script[entity]} engine=${resource}`);
    expect(disagreements).toEqual([]);
  });

  it("invents no entity type the engine does not have", () => {
    const script = parseScriptMap();
    const extra = Object.keys(script).filter((k) => !(k in ENTITY_APPROVE_RESOURCE_MAP));
    expect(extra).toEqual([]);
  });
});
