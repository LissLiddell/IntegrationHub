import { AwsSecretProvider } from "../secure-http-delivery.ts";
import { dynamoDocumentClient, secretsManagerClient } from "../clients.ts";
import { loadAwsConfig } from "../config.ts";
import { DynamoDemoInvocationCounter } from "../dynamo-demo-counter.ts";
import { createDemoDestinationHandler } from "./demo-destination.ts";

const secretArn = process.env.DEMO_DESTINATION_SECRET_ARN?.trim();
if (!secretArn) throw new Error("DEMO_DESTINATION_SECRET_ARN is required.");

const { tableName } = loadAwsConfig();
const tokenProvider = new AwsSecretProvider(secretsManagerClient);

export const handler = createDemoDestinationHandler({
  counter: new DynamoDemoInvocationCounter(dynamoDocumentClient, tableName),
  getExpectedToken() {
    return tokenProvider.getToken(secretArn);
  },
  now: () => new Date()
});
