import assert from "node:assert/strict";
import { validateDeployField } from "./generator.js";

assert.match(
  validateDeployField("APP_BASE_URL", "https://sentinelrelay.workers.dev"),
  /workers\.dev/i
);
assert.equal(
  validateDeployField("APP_BASE_URL", "https://relay.example.com"),
  ""
);

console.log("generator URL validation tests passed");
