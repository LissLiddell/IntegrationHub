import { systemClock, uuidGenerator } from "../../domain/system.ts";
import { repository } from "../runtime.ts";
import { createWebhookHandler } from "./webhook.ts";

export const handler = createWebhookHandler({ repository, clock: systemClock, ids: uuidGenerator });
