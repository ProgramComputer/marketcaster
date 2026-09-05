import type { z } from "zod";

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "value" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function assertNever(value: never, message = "Unexpected value"): never {
  throw new TypeError(`${message}: ${String(value)}`);
}
