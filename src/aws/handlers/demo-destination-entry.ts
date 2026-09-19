import { dynamoDocumentClient } from "../clients.ts";
import { loadAwsConfig } from "../config.ts";
import { DynamoDemoInvocationCounter } from "../dynamo-demo-counter.ts";
import { createDemoDestinationHandler } from "./demo-destination.ts";

const validDemoCredential = process.env.DEMO_VALID_CREDENTIAL?.trim();
if (!validDemoCredential) throw new Error("DEMO_VALID_CREDENTIAL is required.");

const { tableName } = loadAwsConfig();

export const handler = createDemoDestinationHandler({
  counter: new DynamoDemoInvocationCounter(dynamoDocumentClient, tableName),
  getExpectedToken() {
    return Promise.resolve(validDemoCredential);
  },
  now: () => new Date()
});
