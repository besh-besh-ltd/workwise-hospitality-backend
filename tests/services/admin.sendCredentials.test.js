/**
 * Sending login credentials to chosen people (UM-12).
 *
 * This mailed everyone mapped to a business unit, behind a raw
 * window.confirm, with no way to send to one person who had lost their
 * details. The dangerous half of "send to everybody" is not the noise — it is
 * that the mail contains a plaintext password for anyone still on the shared
 * default, so the blast radius of a mistaken click is every account at the
 * unit.
 *
 * The recipient list narrows; it can never extend. Naming a user outside the
 * unit must select nobody rather than mailing them, or the endpoint becomes a
 * way to send an arbitrary account's credentials to their own inbox.
 */
import { db, closeDb } from "../setup/db.js";
import hospitalityModel from "../../app/models/hospitalityModel.js";
import { IDS } from "../fixtures/ids.js";

const COMPANY = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;

afterAll(() => closeDb());

describe("credential recipients", () => {
  it("defaults to everyone mapped to the unit", async () => {
    const all = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL);
    expect(all.length).toBeGreaterThan(1);
  });

  it("narrows to the people chosen", async () => {
    const all = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL);
    const pick = all[0].user_id;

    const some = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL, [pick]);
    expect(some.map((u) => u.user_id)).toEqual([pick]);
  });

  it("ignores a user who is not mapped to the unit", async () => {
    // The list is a filter over who is already eligible, never a way to add
    // somebody to it.
    const outsider = IDS.users.companyB_admin;
    const all = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL);
    expect(all.map((u) => u.user_id)).not.toContain(outsider);

    const result = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL, [outsider]);
    expect(result).toEqual([]);
  });

  it("keeps only the eligible ones from a mixed list", async () => {
    const all = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL);
    const insider = all[0].user_id;
    const outsider = IDS.users.companyB_admin;

    const result = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL, [
      insider,
      outsider,
    ]);
    expect(result.map((u) => u.user_id)).toEqual([insider]);
  });

  it("treats an empty selection as no selection, not as nobody", async () => {
    // An empty array from a UI that has not had a checkbox ticked should not
    // silently mean "send to no one" — the caller omits the field to mean all.
    const all = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL);
    const empty = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL, []);
    expect(empty.length).toBe(all.length);
  });

  it("discards ids that are not numbers", async () => {
    const all = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL);
    const pick = all[0].user_id;
    const result = await hospitalityModel.getUsersForHotelWithPassword(COMPANY, HOTEL, [
      pick,
      "not-an-id",
      null,
    ]);
    expect(result.map((u) => u.user_id)).toEqual([pick]);
  });
});
