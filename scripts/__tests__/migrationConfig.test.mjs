import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConnection, describeTarget } from "../lib/migrationConfig.mjs";

const FULL = {
  HOST: "db.example.com",
  DATABASE_PORT: "5432",
  DATABASE_USERNAME: "postgres",
  DATABASE_PASSWORD: "s3cr3t",
  DATABASE_NAME: "hospitality_main",
};

test("builds a connection object from the repo's env var names", () => {
  assert.deepEqual(buildConnection(FULL), {
    host: "db.example.com",
    port: 5432,
    user: "postgres",
    password: "s3cr3t",
    database: "hospitality_main",
    ssl: { rejectUnauthorized: false },
  });
});

test("defaults the port to 5432 when DATABASE_PORT is absent", () => {
  const { DATABASE_PORT, ...rest } = FULL;
  assert.equal(buildConnection(rest).port, 5432);
});

test("disables ssl only when TEST_DB_NO_SSL is exactly '1'", () => {
  assert.equal(buildConnection({ ...FULL, TEST_DB_NO_SSL: "1" }).ssl, false);
  assert.deepEqual(buildConnection({ ...FULL, TEST_DB_NO_SSL: "0" }).ssl, { rejectUnauthorized: false });
  assert.deepEqual(buildConnection({ ...FULL, TEST_DB_NO_SSL: "true" }).ssl, { rejectUnauthorized: false });
});

test("allows an empty password (local brew Postgres uses peer auth)", () => {
  assert.equal(buildConnection({ ...FULL, DATABASE_PASSWORD: "" }).password, "");
  const { DATABASE_PASSWORD, ...rest } = FULL;
  assert.equal(buildConnection(rest).password, "");
});

test("throws naming every missing variable at once", () => {
  assert.throws(
    () => buildConnection({ DATABASE_PORT: "5432" }),
    /HOST, DATABASE_USERNAME, DATABASE_NAME/
  );
});

test("describeTarget never contains the password", () => {
  const described = describeTarget(buildConnection(FULL));
  assert.equal(described, "postgres@db.example.com:5432/hospitality_main");
  assert.ok(!described.includes("s3cr3t"));
});
