import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "./ports.ts";

export const systemClock: Clock = {
  now: () => new Date()
};

export const uuidGenerator: IdGenerator = {
  next: (prefix) => `${prefix}_${randomUUID()}`
};
