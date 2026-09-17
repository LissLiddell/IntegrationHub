import {
  AwsConnectionCredentialStore,
  AwsSecretProvider,
  DynamoConnectionProvider,
  SecureHttpDelivery
} from "./secure-http-delivery.ts";
import { dynamoDocumentClient, secretsManagerClient, sqsClient } from "./clients.ts";
import { loadAwsConfig } from "./config.ts";
import { DynamoIntegrationRepository } from "./dynamo-repository.ts";
import { SqsRunQueue } from "./sqs-run-queue.ts";

const config = loadAwsConfig();

export const repository = new DynamoIntegrationRepository(dynamoDocumentClient, config.tableName);
export const runQueue = new SqsRunQueue(sqsClient, config.deliveryQueueUrl);
export const connectionCredentialStore = new AwsConnectionCredentialStore(
  dynamoDocumentClient,
  config.tableName,
  secretsManagerClient
);
export const httpDelivery = new SecureHttpDelivery(
  new DynamoConnectionProvider(dynamoDocumentClient, config.tableName),
  new AwsSecretProvider(secretsManagerClient)
);
