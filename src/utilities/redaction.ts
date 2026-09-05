const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu,
  /\b(?:x-api-key|authorization)\s*[:=]\s*[^\s,;]{8,}/giu,
];

const MAXIMUM_PERSISTED_ERROR_MESSAGE_LENGTH = 2_048;

export function redactPotentialSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function safeErrorMessage(
  error: unknown,
  fallback = "Unknown failure",
): string {
  const message = error instanceof Error ? error.message : fallback;
  return redactPotentialSecrets(message).slice(
    0,
    MAXIMUM_PERSISTED_ERROR_MESSAGE_LENGTH,
  );
}

export interface SafeErrorCause {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export function safeErrorCauses(
  error: unknown,
  maximumCauses = 4,
): readonly SafeErrorCause[] {
  const causes: SafeErrorCause[] = [];
  const seen = new Set<Error>();
  let current = error instanceof Error ? error.cause : undefined;
  while (
    current instanceof Error &&
    !seen.has(current) &&
    causes.length < maximumCauses
  ) {
    seen.add(current);
    const code =
      "code" in current && typeof current.code === "string"
        ? redactPotentialSecrets(current.code).slice(0, 100)
        : undefined;
    causes.push({
      name: current.name,
      message: safeErrorMessage(current),
      ...(code === undefined ? {} : { code }),
    });
    current = current.cause;
  }
  return causes;
}
