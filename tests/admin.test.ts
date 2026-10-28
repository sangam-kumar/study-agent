import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdminAuthorized } from "../src/admin.ts";

test("accepts only the exact bearer token", async () => {
  assert.equal(await isAdminAuthorized("Bearer s3cret", "s3cret"), true);
  assert.equal(await isAdminAuthorized("Bearer s3cret ", "s3cret"), false);
  assert.equal(await isAdminAuthorized("Bearer wrong", "s3cret"), false);
  assert.equal(await isAdminAuthorized("s3cret", "s3cret"), false, "scheme is required");
  assert.equal(await isAdminAuthorized("bearer s3cret", "s3cret"), false);
  assert.equal(await isAdminAuthorized(null, "s3cret"), false);
});

test("admin is disabled when no token is configured, even for an empty bearer", async () => {
  assert.equal(await isAdminAuthorized("Bearer anything", undefined), false);
  assert.equal(await isAdminAuthorized("Bearer anything", ""), false);
  assert.equal(await isAdminAuthorized("Bearer ", ""), false);
});
