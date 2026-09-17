import { runQueue } from "../runtime.ts";
import { createOutboxDispatcher } from "./outbox-dispatcher.ts";

export const handler = createOutboxDispatcher(runQueue);
