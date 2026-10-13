/**
 * A gap in the activity catalogue must be visible in the logs, once.
 *
 * The uncatalogued-route counter lives in process memory: it resets on every
 * deploy and is only seen by someone who thinks to call the coverage endpoint.
 * That is how a dropped company-admin event went unnoticed for weeks. The gap
 * is now also written to the log pipeline (and so to alerting) — but once per
 * route per process, because a query-shaped POST fired on every page load
 * would otherwise drown the log in the same line.
 */
import { jest } from "@jest/globals";
import { closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { logger } from "../../app/util/logger.js";
import {
  getUncataloguedRoutes,
  resetUncataloguedRoutes,
  resetGapWarnings,
} from "../../app/middleware/activityCapture.js";

const ADMIN = IDS.users.companyA_admin;

const gapWarnings = (spy, route) =>
  spy.mock.calls.filter(
    ([fields, msg]) => msg === "Activity trail gap: event not recorded" && fields?.route === route
  );

afterAll(async () => {
  await closeDb();
});

describe("activity trail gap logging", () => {
  it("logs an uncatalogued route once however often it is hit, and keeps counting", async () => {
    resetUncataloguedRoutes();
    resetGapWarnings();
    const spy = jest.spyOn(logger, "warn");
    try {
      const client = await httpClient(ADMIN);
      await client.post("/api/v1/rfq/list-view").send({});
      await client.post("/api/v1/rfq/list-view").send({});
      await new Promise((r) => setTimeout(r, 400));

      const warnings = gapWarnings(spy, "/rfq/list-view");
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toMatchObject({ method: "POST", reason: "uncatalogued" });
      const gap = getUncataloguedRoutes().find((g) => g.route === "POST /rfq/list-view");
      expect(gap?.count).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not log a route on the NOT_AN_EVENT list", async () => {
    resetGapWarnings();
    const spy = jest.spyOn(logger, "warn");
    try {
      const client = await httpClient(ADMIN);
      await client.post("/api/v1/rbac/me/permissions/bulk").send({ hotel_ids: [IDS.hotels.A1] });
      await new Promise((r) => setTimeout(r, 400));
      expect(gapWarnings(spy, "/rbac/me/permissions/bulk")).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
