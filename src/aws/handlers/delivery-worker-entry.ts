import { systemClock, uuidGenerator } from "../../domain/system.ts";
import { httpDelivery, repository } from "../runtime.ts";
import { createDeliveryWorker } from "./delivery-worker.ts";

export const handler = createDeliveryWorker({
  repository,
  delivery: httpDelivery,
  clock: systemClock,
  ids: uuidGenerator
});
