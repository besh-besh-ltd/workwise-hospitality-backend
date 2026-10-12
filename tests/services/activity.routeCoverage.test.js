/**
 * Every company-administration endpoint must either be named in the activity
 * registry or be on its explicit NOT_AN_EVENT list.
 *
 * Capture is registry-driven: a mutating route with no entry produces no line
 * in the activity trail. That is deliberate (57 POST routes are queries), but
 * it means a new admin endpoint is unlogged by default — which is how editing
 * an approval workflow, project mapping and the company profile all went
 * unrecorded. This walks the real Express app, so a route added next month
 * fails here until somebody decides, in writing, whether it is an event.
 *
 * Scope: the four routers company administration lives under. Sourcing, POs,
 * ARC and MR have their own catalogue sections and are out of scope here.
 */
import { buildTestApp } from "../setup/app.js";
import { EVENTS, NOT_AN_EVENT, lookupEvent, isNotAnEvent } from "../../app/services/activity/eventRegistry.js";

const MUTATING = ["post", "put", "patch", "delete"];
const ADMIN_PREFIXES = ["/users", "/hospitality", "/rbac", "/general"];

/** "/^\/api\/v1\/?(?=\/|$)/i" -> "/api/v1". Express 4 keeps only the regexp. */
const mountPath = (layer) => {
  if (layer.regexp?.fast_slash) return "";
  const src = layer.regexp?.source || "";
  const m = src.match(/^\^((?:\\\/|[^\\^$?*+()[\]{}|])*)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) return null;
  return m[1].replace(/\\\//g, "/");
};

/** Every [METHOD, path] the app serves, path relative to /api/v1. */
const collectRoutes = (stack, prefix = "") => {
  const out = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (!MUTATING.includes(method)) continue;
        const path = layer.route.path === "/" ? prefix || "/" : `${prefix}${layer.route.path}`;
        out.push([method.toUpperCase(), path]);
      }
    } else if (layer.handle?.stack) {
      const mount = mountPath(layer);
      if (mount === null) continue;
      out.push(...collectRoutes(layer.handle.stack, `${prefix}${mount}`));
    }
  }
  return out;
};

let routes;

beforeAll(async () => {
  const app = await buildTestApp();
  routes = collectRoutes(app._router.stack)
    .filter(([, path]) => path.startsWith("/api/v1/"))
    .map(([method, path]) => [method, path.replace(/^\/api\/v1/, "")]);
});

describe("activity registry coverage of company administration", () => {
  it("finds the admin routers at all (guards the walker itself)", () => {
    const admin = routes.filter(([, p]) => ADMIN_PREFIXES.some((x) => p.startsWith(`${x}/`)));
    // If the walker silently matched nothing this suite would pass vacuously.
    expect(admin.length).toBeGreaterThan(60);
    expect(admin).toContainEqual(["POST", "/rbac/roles"]);
    expect(admin).toContainEqual(["DELETE", "/hospitality/user/:user_id/mapping"]);
    expect(admin).toContainEqual(["PUT", "/general/hospitality/approval/processes/:id"]);
    expect(admin).toContainEqual(["PUT", "/users/update-company-detail"]);
    expect(admin.filter(([, p]) => p.startsWith("/general/")).length).toBeGreaterThan(10);
  });

  it("names or explicitly excludes every mutating admin route", () => {
    const gaps = routes
      .filter(([, p]) => ADMIN_PREFIXES.some((x) => p.startsWith(`${x}/`)))
      .filter(([m, p]) => !lookupEvent(m, p) && !isNotAnEvent(m, p))
      .map(([m, p]) => `${m} ${p}`);
    expect(gaps).toEqual([]);
  });

  it("never lists a route as both an event and not an event", () => {
    const both = NOT_AN_EVENT.filter((key) => {
      const [m, ...rest] = key.split(" ");
      return lookupEvent(m, rest.join(" "));
    });
    expect(both).toEqual([]);
  });

  it("has no registry entry for a route the app does not serve", () => {
    // A pattern that matches nothing is a silent failure: the event stays
    // unnamed forever. Only checked for the admin routers walked here.
    const served = new Set(routes.map(([m, p]) => `${m} ${p}`));
    const stale = EVENTS
      .filter((ev) => ev.method !== "GET")
      .filter((ev) => ADMIN_PREFIXES.some((x) => ev.path.startsWith(`${x}/`)))
      .map((ev) => `${ev.method} ${ev.path}`)
      .filter((key) => !served.has(key));
    expect(stale).toEqual([]);
  });

  it("has no allow-list entry for a route the app does not serve", () => {
    const served = new Set(routes.map(([m, p]) => `${m} ${p}`));
    expect(NOT_AN_EVENT.filter((key) => !served.has(key))).toEqual([]);
  });
});
