import { randomBytes } from "node:crypto";
import { sha256 } from "../src/aws/dynamo-keys.ts";

const controlKey = randomBytes(32).toString("base64url");
const webhookToken = `wh_${randomBytes(24).toString("base64url")}`;

console.log("Save these values in a private place; they are not written to disk.");
console.log(`DEMO_CONTROL_KEY=${controlKey}`);
console.log(`DEMO_ACCESS_KEY_SHA256=${sha256(controlKey)}`);
console.log(`DEMO_WEBHOOK_TOKEN=${webhookToken}`);
