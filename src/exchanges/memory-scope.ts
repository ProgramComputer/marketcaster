import { createHash } from "node:crypto";

import type { ExchangeId } from "../domain/primitives.js";

const MEMORY_SCOPE_DOMAIN = "marketcaster-agent-memory-scope-v1";
const SAFE_MEMORY_SCOPE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

export const UNSCOPED_MEMORY_SCOPE = "unscoped";

export function assertSafeMemoryScope(value: string): string {
  if (!SAFE_MEMORY_SCOPE.test(value)) {
    throw new Error("Exchange memory scope is not filesystem-safe");
  }
  return value;
}

export function deriveExchangeMemoryScope(
  exchangeId: ExchangeId,
  keyId: string,
  override?: string,
  namespace?: string,
): string {
  const sourceKind = override === undefined ? "account" : "profile";
  const source = override ?? keyId;
  if (source.length === 0) {
    throw new Error("Exchange memory scope source cannot be empty");
  }
  if (namespace?.length === 0) {
    throw new Error("Exchange memory scope namespace cannot be empty");
  }
  const identity =
    namespace === undefined
      ? [MEMORY_SCOPE_DOMAIN, exchangeId, sourceKind, source]
      : [MEMORY_SCOPE_DOMAIN, exchangeId, namespace, sourceKind, source];
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 32);
  return assertSafeMemoryScope(`${sourceKind}-${digest}`);
}
