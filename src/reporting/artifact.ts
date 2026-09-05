import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Decimal } from "decimal.js";

const ATOMIC_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const ATOMIC_RENAME_MAXIMUM_ATTEMPTS = 8;

function filesystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error as { readonly code?: unknown };
  return typeof code === "string" ? code : undefined;
}

async function retryAtomicRename(
  source: string,
  target: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const retryable = ATOMIC_RENAME_RETRY_CODES.has(
        filesystemErrorCode(error) ?? "",
      );
      if (!retryable || attempt + 1 >= ATOMIC_RENAME_MAXIMUM_ATTEMPTS) {
        throw error;
      }
      const delayMilliseconds = Math.min(800, 25 * 2 ** attempt);
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, delayMilliseconds);
      });
    }
  }
}

export function reportJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Decimal) return value.toFixed();
  if (value instanceof Date) return value.toISOString();
  return value;
}

export async function writeJsonArtifact(
  directory: string,
  filename: string,
  value: unknown,
  options: { readonly overwrite?: boolean } = {},
): Promise<string> {
  const resolvedDirectory = resolve(process.cwd(), directory);
  const path = resolve(resolvedDirectory, filename);
  const pathWithinDirectory = relative(resolvedDirectory, path);
  if (
    pathWithinDirectory.startsWith("..") ||
    isAbsolute(pathWithinDirectory) ||
    pathWithinDirectory.includes(":") ||
    pathWithinDirectory.length === 0
  ) {
    throw new Error("Artifact path escaped the configured report directory");
  }

  const targetDirectory = dirname(path);
  await mkdir(targetDirectory, { recursive: true });
  const temporaryPath = resolve(
    targetDirectory,
    `.${randomUUID()}.artifact.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(
      `${JSON.stringify(value, reportJsonReplacer, 2)}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.overwrite === false) {
      await link(temporaryPath, path);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    } else {
      await retryAtomicRename(temporaryPath, path);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}
