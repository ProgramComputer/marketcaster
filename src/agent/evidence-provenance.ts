import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, type Dispatcher } from "undici";
import type { AgentDecision, DecisionEvidence } from "./decision-schema.js";
import type { Market } from "../domain/market.js";

export type EvidenceSourceProvider =
  | "CLIENT_WEB_SEARCH"
  | "ANTHROPIC_WEB_SEARCH"
  | "OPENAI_WEB_SEARCH"
  | "SYSTEM_LIVE_FEED";

export interface ObservedEvidenceSource {
  readonly url: string;
  readonly title: string;
  readonly excerpt?: string;
  readonly observedAt: string;
  readonly publishedAt?: string;
  readonly pageAge?: string;
  readonly provider: EvidenceSourceProvider;
}

export type EvidencePageReadFailureReason =
  | "ACCESS_DENIED"
  | "FETCH_FAILED"
  | "HTTP_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "UNSAFE_URL"
  | "UNSUPPORTED_CONTENT";

export class EvidencePageReadError extends Error {
  public constructor(
    public readonly reason: EvidencePageReadFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "EvidencePageReadError";
  }
}

export function evidencePageReadFailureReason(
  error: unknown,
): EvidencePageReadFailureReason {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof EvidencePageReadError) return current.reason;
    if (
      current instanceof Error &&
      (current.name === "AbortError" || current.name === "TimeoutError")
    ) {
      return "TIMEOUT";
    }
    current =
      current instanceof Error
        ? (current as Error & { readonly cause?: unknown }).cause
        : undefined;
  }
  return "FETCH_FAILED";
}

export function canonicalEvidenceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Evidence URL must use HTTP or HTTPS");
  }
  url.hash = "";
  url.hostname = url.hostname.toLocaleLowerCase("en-US");
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function validTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function mergeText(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  const values = [left, right]
    .map((value) => value?.trim())
    .filter(
      (value): value is string => value !== undefined && value.length > 0,
    );
  return values.length === 0 ? undefined : [...new Set(values)].join("\n");
}

export class EvidenceSourceRegistry {
  readonly #sources = new Map<string, ObservedEvidenceSource>();

  public register(source: ObservedEvidenceSource): void {
    const key = canonicalEvidenceUrl(source.url);
    const observedAt = validTimestamp(source.observedAt);
    if (observedAt === undefined) {
      throw new TypeError("Observed evidence source has an invalid observedAt");
    }
    const existing = this.#sources.get(key);
    const excerpt = mergeText(existing?.excerpt, source.excerpt);
    const publishedAt =
      validTimestamp(source.publishedAt) ?? existing?.publishedAt;
    const pageAge = source.pageAge ?? existing?.pageAge;
    const suppliedTitle = source.title.trim();
    this.#sources.set(key, {
      url: key,
      title:
        suppliedTitle.length > 0 ? suppliedTitle : (existing?.title ?? key),
      ...(excerpt === undefined ? {} : { excerpt }),
      observedAt:
        existing === undefined ||
        Date.parse(observedAt) < Date.parse(existing.observedAt)
          ? observedAt
          : existing.observedAt,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(pageAge === undefined ? {} : { pageAge }),
      provider: source.provider,
    });
  }

  public get(url: string): ObservedEvidenceSource | undefined {
    try {
      return this.#sources.get(canonicalEvidenceUrl(url));
    } catch {
      return undefined;
    }
  }

  public get sources(): readonly ObservedEvidenceSource[] {
    return [...this.#sources.values()];
  }

  public clear(): void {
    this.#sources.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(
  value: unknown,
  visit: (record: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function extractAnthropicEvidenceSources(
  response: unknown,
  observedAt = new Date(),
): readonly ObservedEvidenceSource[] {
  const byUrl = new Map<string, ObservedEvidenceSource>();
  walk(response, (record) => {
    if (
      record.type !== "web_search_result" &&
      record.type !== "web_search_result_location"
    ) {
      return;
    }
    const url = stringField(record, "url");
    if (url === undefined) return;
    let key: string;
    try {
      key = canonicalEvidenceUrl(url);
    } catch {
      return;
    }
    const prior = byUrl.get(key);
    const title = stringField(record, "title") ?? prior?.title ?? key;
    const excerpt = mergeText(
      prior?.excerpt,
      stringField(record, "cited_text") ??
        stringField(record, "snippet") ??
        stringField(record, "content"),
    );
    const publishedAt =
      stringField(record, "published_at") ?? prior?.publishedAt;
    const pageAge = stringField(record, "page_age") ?? prior?.pageAge;
    byUrl.set(key, {
      url: key,
      title,
      ...(excerpt === undefined ? {} : { excerpt }),
      observedAt: observedAt.toISOString(),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(pageAge === undefined ? {} : { pageAge }),
      provider: "ANTHROPIC_WEB_SEARCH",
    });
  });
  return [...byUrl.values()];
}

export function extractOpenAIEvidenceSources(
  response: unknown,
  observedAt = new Date(),
): readonly ObservedEvidenceSource[] {
  const byUrl = new Map<string, ObservedEvidenceSource>();
  walk(response, (record) => {
    if (
      record.type !== "url_citation" &&
      record.type !== "web_search_result" &&
      record.type !== "web_search_result_location"
    ) {
      return;
    }
    const url = stringField(record, "url");
    if (url === undefined) return;
    let key: string;
    try {
      key = canonicalEvidenceUrl(url);
    } catch {
      return;
    }
    const prior = byUrl.get(key);
    const excerpt = mergeText(
      prior?.excerpt,
      stringField(record, "cited_text") ?? stringField(record, "snippet"),
    );
    const publishedAt =
      stringField(record, "published_at") ?? prior?.publishedAt;
    byUrl.set(key, {
      url: key,
      title: stringField(record, "title") ?? prior?.title ?? key,
      ...(excerpt === undefined ? {} : { excerpt }),
      observedAt: observedAt.toISOString(),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      provider: "OPENAI_WEB_SEARCH",
    });
  });
  return [...byUrl.values()];
}

export function xSnowflakeTimestamp(urlValue: string): Date | undefined {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return undefined;
  }
  if (
    !new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]).has(
      url.hostname.toLowerCase(),
    )
  ) {
    return undefined;
  }
  const match = /\/status\/(\d{10,})/u.exec(url.pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    const milliseconds = (BigInt(match[1]) >> 22n) + 1_288_834_974_657n;
    const numeric = Number(milliseconds);
    if (!Number.isSafeInteger(numeric)) return undefined;
    const date = new Date(numeric);
    return Number.isNaN(date.getTime()) ? undefined : date;
  } catch {
    return undefined;
  }
}

function buildNonPublicIpBlockList(): BlockList {
  const blockList = new BlockList();
  const ipv4Subnets = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 16],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 3],
  ] as const;
  const ipv6Subnets = [
    ["64:ff9b:1::", 48],
    ["fc00::", 7],
    ["fec0::", 10],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32],
  ] as const;
  for (const [network, prefix] of ipv4Subnets) {
    blockList.addSubnet(network, prefix, "ipv4");
  }
  blockList.addAddress("::", "ipv6");
  blockList.addAddress("::1", "ipv6");
  for (const [network, prefix] of ipv6Subnets) {
    blockList.addSubnet(network, prefix, "ipv6");
  }
  return blockList;
}

const NON_PUBLIC_IP_ADDRESSES = buildNonPublicIpBlockList();
const IPV4_TRANSLATION_PREFIXES = new BlockList();
IPV4_TRANSLATION_PREFIXES.addSubnet("64:ff9b::", 96, "ipv6");
IPV4_TRANSLATION_PREFIXES.addSubnet("::ffff:0:0:0", 96, "ipv6");

function unbracketIpLiteral(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function ipv6Words(address: string): readonly number[] | undefined {
  let canonical: string;
  try {
    canonical = unbracketIpLiteral(
      new URL(`http://[${unbracketIpLiteral(address)}]/`).hostname,
    );
  } catch {
    return undefined;
  }
  const halves = canonical.split("::");
  if (halves.length > 2) return undefined;
  const words = (value: string): number[] =>
    value.length === 0
      ? []
      : value.split(":").map((word) => Number.parseInt(word, 16));
  const left = words(halves[0] ?? "");
  const right = words(halves[1] ?? "");
  const expanded =
    halves.length === 1
      ? left
      : [
          ...left,
          ...Array.from({ length: 8 - left.length - right.length }, () => 0),
          ...right,
        ];
  return expanded.length === 8 &&
    expanded.every(
      (word) => Number.isInteger(word) && word >= 0 && word <= 0xffff,
    )
    ? expanded
    : undefined;
}

function translatedIpv4Address(address: string): string | undefined {
  if (!IPV4_TRANSLATION_PREFIXES.check(address, "ipv6")) return undefined;
  const words = ipv6Words(address);
  if (words === undefined) return undefined;
  const high = words[6] ?? 0;
  const low = words[7] ?? 0;
  return [
    Math.floor(high / 256),
    high % 256,
    Math.floor(low / 256),
    low % 256,
  ].join(".");
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = unbracketIpLiteral(address);
  const family = isIP(normalized);
  if (family === 4) return !NON_PUBLIC_IP_ADDRESSES.check(normalized, "ipv4");
  if (family === 6) {
    if (NON_PUBLIC_IP_ADDRESSES.check(normalized, "ipv6")) return false;
    if (!IPV4_TRANSLATION_PREFIXES.check(normalized, "ipv6")) return true;
    const translatedIpv4 = translatedIpv4Address(normalized);
    return (
      translatedIpv4 !== undefined &&
      !NON_PUBLIC_IP_ADDRESSES.check(translatedIpv4, "ipv4")
    );
  }
  return false;
}

export async function assertPublicEvidenceUrl(
  urlValue: string,
  lookupImplementation: typeof lookup = lookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new EvidencePageReadError("UNSAFE_URL", "Evidence URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EvidencePageReadError(
      "UNSAFE_URL",
      "Only HTTP(S) evidence URLs are fetchable",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new EvidencePageReadError(
      "UNSAFE_URL",
      "Evidence URLs cannot contain credentials",
    );
  }
  const hostname = unbracketIpLiteral(url.hostname.toLowerCase());
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new EvidencePageReadError(
      "UNSAFE_URL",
      "Evidence URL resolves to a local hostname",
    );
  }
  if (isIP(hostname) !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw new EvidencePageReadError(
        "UNSAFE_URL",
        "Evidence URL resolves to a non-public address",
      );
    }
    return url;
  }
  const addresses = await lookupImplementation(hostname, {
    all: true,
    verbatim: true,
  });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicIpAddress(address))
  ) {
    throw new EvidencePageReadError(
      "UNSAFE_URL",
      "Evidence URL DNS includes a non-public address",
    );
  }
  return url;
}

export interface FetchedEvidencePage {
  readonly text: string;
  readonly publishedAt?: string;
  readonly finalUrl: string;
}

function pageText(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/giu, "\n")
    .replace(
      /<\/(?:address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tr|ul)\s*>/giu,
      "\n",
    )
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function structuredPublishedAt(source: string): string | undefined {
  const patterns = [
    /(?:article:published_time|datePublished)[^>\n]{0,200}?(?:content=|:\s*)["']?([^"'<>,}]+?\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/iu,
    /<time[^>]+datetime=["']([^"']+)["']/iu,
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(source)?.[1];
    const timestamp = validTimestamp(value);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

const MAXIMUM_EVIDENCE_RESPONSE_BYTES = 4 * 1_048_576;
const EVIDENCE_READER_USER_AGENT =
  "MarketCaster/0.1 evidence-reader (+https://github.com/ProgramComputer/marketcaster)";

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing a rejected or redirect response is best-effort only.
  }
}

function normalizedError(reason: unknown, message: string): Error {
  return reason instanceof Error
    ? reason
    : new Error(message, { cause: reason });
}

async function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(normalizedError(signal.reason, "Evidence operation aborted"));
    };
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(normalizedError(error, "Evidence operation failed"));
      },
    );
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function guardedLookup(
  lookupImplementation: typeof lookup,
  signal: AbortSignal,
): LookupFunction {
  return (hostname, options, callback) => {
    void awaitWithSignal(
      lookupImplementation(hostname, { all: true, verbatim: true }),
      signal,
    ).then(
      (addresses) => {
        if (
          addresses.length === 0 ||
          addresses.some(({ address }) => !isPublicIpAddress(address))
        ) {
          callback(
            new EvidencePageReadError(
              "UNSAFE_URL",
              "Evidence URL DNS includes a non-public address",
            ),
            "",
          );
          return;
        }
        const requestedFamily =
          options.family === 4 || options.family === 6
            ? options.family
            : undefined;
        const eligible =
          requestedFamily === undefined
            ? addresses
            : addresses.filter(({ family }) => family === requestedFamily);
        const selected = eligible[0];
        if (selected === undefined) {
          callback(
            new EvidencePageReadError(
              "FETCH_FAILED",
              "Evidence URL DNS did not return the requested address family",
            ),
            "",
          );
          return;
        }
        if (options.all === true) {
          callback(null, eligible);
          return;
        }
        callback(null, selected.address, selected.family);
      },
      (error: unknown) => {
        callback(
          error instanceof Error ? error : new Error("Evidence DNS failed"),
          "",
        );
      },
    );
  };
}

function fetchWithDispatcher(dispatcher: Dispatcher): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      dispatcher,
    } as RequestInit & { readonly dispatcher: Dispatcher });
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  maximumBytes = MAXIMUM_EVIDENCE_RESPONSE_BYTES,
): Promise<string> {
  if (response.body === null) return "";
  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let total = 0;
  let source = "";
  for (;;) {
    const chunk = await awaitWithSignal(reader.read(), signal).catch(
      (error: unknown) => {
        void reader.cancel().catch(() => undefined);
        throw error;
      },
    );
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new EvidencePageReadError(
        "RESPONSE_TOO_LARGE",
        `Evidence page exceeded the ${maximumBytes}-byte limit`,
      );
    }
    source += decoder.decode(chunk.value, { stream: true });
  }
  source += decoder.decode();
  return source;
}

export async function fetchEvidencePage(
  urlValue: string,
  options: {
    readonly fetchImplementation?: typeof fetch;
    readonly lookupImplementation?: typeof lookup;
    readonly signal?: AbortSignal;
  } = {},
): Promise<FetchedEvidencePage> {
  const lookupImplementation = options.lookupImplementation ?? lookup;
  const timeoutSignal = AbortSignal.timeout(10_000);
  const fetchSignal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
  let dispatcher: Agent | undefined;
  let fetchImplementation = options.fetchImplementation;
  if (fetchImplementation === undefined) {
    dispatcher = new Agent({
      connect: {
        lookup: guardedLookup(lookupImplementation, fetchSignal),
      },
    });
    fetchImplementation = fetchWithDispatcher(dispatcher);
  }
  try {
    let current = await awaitWithSignal(
      assertPublicEvidenceUrl(urlValue, lookupImplementation),
      fetchSignal,
    );
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetchImplementation(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,text/plain,application/json",
          "accept-language": "en-US,en;q=0.8",
          "user-agent": EVIDENCE_READER_USER_AGENT,
        },
        signal: fetchSignal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await cancelResponseBody(response);
        if (location === null || redirects === 3) {
          throw new EvidencePageReadError(
            "HTTP_ERROR",
            "Evidence redirect chain is invalid or too long",
          );
        }
        current = await awaitWithSignal(
          assertPublicEvidenceUrl(
            new URL(location, current).toString(),
            lookupImplementation,
          ),
          fetchSignal,
        );
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new EvidencePageReadError(
          response.status === 401 || response.status === 403
            ? "ACCESS_DENIED"
            : "HTTP_ERROR",
          `Evidence fetch failed with HTTP ${response.status}`,
        );
      }
      const contentType =
        response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        !/^(?:text\/(?:html|plain)|application\/(?:json|ld\+json))(?:;|$)/u.test(
          contentType,
        )
      ) {
        await cancelResponseBody(response);
        throw new EvidencePageReadError(
          "UNSUPPORTED_CONTENT",
          "Evidence response has an unsupported content type",
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAXIMUM_EVIDENCE_RESPONSE_BYTES
      ) {
        await cancelResponseBody(response);
        throw new EvidencePageReadError(
          "RESPONSE_TOO_LARGE",
          `Evidence page declared more than ${MAXIMUM_EVIDENCE_RESPONSE_BYTES} bytes`,
        );
      }
      const source = await readBoundedBody(response, fetchSignal);
      const publishedAt = structuredPublishedAt(source);
      // Source selection belongs to the caller; never enrich from a second URL.
      const text = contentType.startsWith("text/html")
        ? pageText(source)
        : source.replace(/\r\n?/gu, "\n").trim();
      return {
        text,
        ...(publishedAt === undefined ? {} : { publishedAt }),
        finalUrl: current.toString(),
      };
    }
    throw new EvidencePageReadError(
      "HTTP_ERROR",
      "Evidence redirect resolution failed",
    );
  } finally {
    await dispatcher?.destroy();
  }
}

export type EvidenceValidationIssueCode =
  | "SOURCE_NOT_OBSERVED"
  | "SOURCE_FETCH_FAILED"
  | "CLAIM_EXCERPT_NOT_FOUND"
  | "CLAIM_NUMERIC_DETAIL_UNSUPPORTED"
  | "PUBLICATION_DATE_UNVERIFIED"
  | "MODEL_DATE_MISMATCH"
  | "STALE_SOURCE"
  | "FUTURE_SOURCE"
  | "EVENT_YEAR_MISMATCH"
  | "EVENT_YEAR_UNSUPPORTED"
  | "UNREFERENCED_EVIDENCE_BUNDLE"
  | "INSUFFICIENT_CURRENT_DOMAINS";

export interface EvidenceValidationIssue {
  readonly code: EvidenceValidationIssueCode;
  readonly marketSlug: string;
  readonly url?: string;
  readonly message: string;
}

export interface VerifiedEvidenceSource {
  readonly marketSlug: string;
  readonly url: string;
  readonly domain: string;
  readonly evidenceClass: NonNullable<DecisionEvidence["evidenceClass"]>;
  readonly authoritativeAt?: string;
  readonly expectedEventYear: number;
  readonly freshnessLimitDays: number;
}

export interface EvidenceValidationReport {
  readonly valid: boolean;
  readonly verifiedSources: readonly VerifiedEvidenceSource[];
  readonly verifiedCurrentUrls: readonly string[];
  readonly independentCurrentDomains: readonly string[];
  /** Evidence defects on items that cannot authorize an exchange order. */
  readonly advisoryIssues: readonly EvidenceValidationIssue[];
  readonly issues: readonly EvidenceValidationIssue[];
}

function expectedEventYear(market: Market, now: Date): number {
  const closeYear = market.closesAt?.getUTCFullYear();
  const primaryYears = [
    ...`${market.title} ${market.slug}`.matchAll(/\b((?:19|20)\d{2})\b/gu),
  ]
    .map((match) => Number(match[1]))
    .filter((year) => Number.isInteger(year));
  if (primaryYears.length === 1 && primaryYears[0] !== undefined) {
    return primaryYears[0];
  }
  if (closeYear !== undefined && primaryYears.includes(closeYear)) {
    return closeYear;
  }
  const ruleYears = [
    ...`${market.description} ${market.settlementRules}`.matchAll(
      /\b((?:19|20)\d{2})\b/gu,
    ),
  ]
    .map((match) => Number(match[1]))
    .filter((year) => Number.isInteger(year));
  if (ruleYears.length === 1 && ruleYears[0] !== undefined) {
    return ruleYears[0];
  }
  if (closeYear !== undefined && ruleYears.includes(closeYear)) {
    return closeYear;
  }
  return closeYear ?? now.getUTCFullYear();
}

function freshnessDays(market: Market, now: Date): number {
  const close = market.closesAt?.getTime() ?? now.getTime();
  const days = Math.ceil(Math.max(0, close - now.getTime()) / 86_400_000);
  return Math.max(7, Math.min(90, days));
}

function dateFromUrl(urlValue: string): Date | undefined {
  const pathname = new URL(urlValue).pathname;
  const separated =
    /(?:^|[/_-])((?:19|20)\d{2})[/_-](0[1-9]|1[0-2])[/_-]([0-2]\d|3[01])(?:$|[/_-])/u.exec(
      pathname,
    );
  const compact =
    /(?:^|\D)((?:19|20)\d{2})(0[1-9]|1[0-2])([0-2]\d|3[01])(?:\D|$)/u.exec(
      pathname,
    );
  const match = separated ?? compact;
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : undefined;
}

function providerDate(source: ObservedEvidenceSource): Date | undefined {
  const xDate = xSnowflakeTimestamp(source.url);
  if (xDate !== undefined) return xDate;
  const publishedTimestamp = validTimestamp(source.publishedAt);
  if (publishedTimestamp !== undefined) return new Date(publishedTimestamp);
  // A calendar date embedded in a publisher URL is exact. Search-provider
  // page-age strings such as "1 week ago" are observation-relative and can be
  // off by more than a day, so they must not override that exact date.
  const urlDate = dateFromUrl(source.url);
  if (urlDate !== undefined) return urlDate;
  const pageTimestamp = validTimestamp(source.pageAge);
  if (pageTimestamp !== undefined) return new Date(pageTimestamp);
  if (source.pageAge !== undefined) {
    const relative =
      /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/iu.exec(
        source.pageAge.trim(),
      );
    if (relative?.[1] !== undefined && relative[2] !== undefined) {
      const count = Number(relative[1]);
      const units: Record<string, number> = {
        minute: 60_000,
        hour: 3_600_000,
        day: 86_400_000,
        week: 604_800_000,
        month: 2_629_746_000,
        year: 31_556_952_000,
      };
      const unit = units[relative[2].toLowerCase()];
      if (unit !== undefined && Number.isFinite(count)) {
        return new Date(Date.parse(source.observedAt) - count * unit);
      }
    }
    const parsed = Date.parse(source.pageAge);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return undefined;
}

function decodeHtmlCharacterReferences(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    deg: "°",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  const decodedNamed = value.replace(
    /&(amp|apos|deg|gt|lt|nbsp|quot);/giu,
    (match, name: string) => named[name.toLowerCase()] ?? match,
  );
  const decodeCodePoint = (match: string, digits: string, radix: number) => {
    const codePoint = Number.parseInt(digits, radix);
    return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  };
  return decodedNamed
    .replace(/&#x([\da-f]+);/giu, (match, digits: string) =>
      decodeCodePoint(match, digits, 16),
    )
    .replace(/&#(\d+);/gu, (match, digits: string) =>
      decodeCodePoint(match, digits, 10),
    );
}

function normalizedExcerpt(value: string): string {
  return decodeHtmlCharacterReferences(value)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizedNumericToken(value: string): string {
  const numeric = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return value;
  return Object.is(numeric, -0) ? "0" : String(numeric);
}

/**
 * Returns numeric facts asserted by an evidence item's relevance text that do
 * not occur in its verbatim claim excerpt or supplied authoritative context.
 * Market thresholds and event dates may be stated in relevance to explain why
 * a source fact matters, but only when those numbers independently occur in
 * the inspected contract or validated evidence metadata. Derived prices,
 * probabilities, and calculations remain unsupported and belong in the
 * target thesis.
 */
export function unsupportedEvidenceNumericDetails(
  relevance: string,
  claimExcerpt: string,
  authoritativeContext = "",
): readonly string[] {
  const extract = (value: string): readonly string[] =>
    [
      ...value.matchAll(
        /(?<![\p{L}\p{N}])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\p{L}\p{N}])/gu,
      ),
    ].map((match) => normalizedNumericToken(match[0]));
  const excerptNumbers = new Set(extract(claimExcerpt));
  const authoritativeNumbers = new Set(extract(authoritativeContext));
  return [
    ...new Set(
      extract(relevance).filter(
        (value) =>
          !excerptNumbers.has(value) && !authoritativeNumbers.has(value),
      ),
    ),
  ];
}

function liveDataAsOfMatchesObservation(
  authoritativeDate: Date,
  observedTime: Date,
): boolean {
  const absoluteDifference = Math.abs(
    authoritativeDate.getTime() - observedTime.getTime(),
  );
  if (absoluteDifference <= 86_400_000) return true;

  const isDateOnlyMidnight =
    authoritativeDate.getUTCHours() === 0 &&
    authoritativeDate.getUTCMinutes() === 0 &&
    authoritativeDate.getUTCSeconds() === 0 &&
    authoritativeDate.getUTCMilliseconds() === 0;
  if (!isDateOnlyMidnight) return false;

  const authoritativeDay = Date.UTC(
    authoritativeDate.getUTCFullYear(),
    authoritativeDate.getUTCMonth(),
    authoritativeDate.getUTCDate(),
  );
  const observedDay = Date.UTC(
    observedTime.getUTCFullYear(),
    observedTime.getUTCMonth(),
    observedTime.getUTCDate(),
  );
  return observedDay - authoritativeDay === 86_400_000;
}

function sourceDomain(urlValue: string): string {
  return new URL(urlValue).hostname.toLowerCase().replace(/^www\./u, "");
}

function currentEvidenceRequired(item: {
  readonly kind: "TARGET" | "DISPOSITION";
  readonly reasonCode?: string;
  readonly hasProbability: boolean;
}): boolean {
  return (
    item.kind === "TARGET" ||
    item.reasonCode === "NO_POSITIVE_EDGE" ||
    item.hasProbability
  );
}

/** Validates source observation, authoritative dates, freshness, and event year. */
export async function validateDecisionEvidence(input: {
  readonly decision: AgentDecision;
  readonly observedSources: readonly ObservedEvidenceSource[];
  readonly marketsBySlug: ReadonlyMap<string, Market>;
  readonly minimumIndependentSources: number;
  /** Targets that currently derive an exchange order and therefore authorize action. */
  readonly blockingTargetMarketSlugs?: ReadonlySet<string>;
  readonly now?: Date;
  readonly fetchImplementation?: typeof fetch;
  readonly lookupImplementation?: typeof lookup;
  readonly signal?: AbortSignal;
}): Promise<EvidenceValidationReport> {
  const now = input.now ?? new Date();
  const registry = new EvidenceSourceRegistry();
  for (const source of input.observedSources) registry.register(source);
  const issues: EvidenceValidationIssue[] = [];
  const advisoryIssues: EvidenceValidationIssue[] = [];
  const verified: VerifiedEvidenceSource[] = [];
  const verifiedKeys = new Set<string>();
  const fetchCache = new Map<string, Promise<FetchedEvidencePage>>();
  const decisionItems = [
    ...input.decision.portfolioTargets.map((target) => ({
      kind: "TARGET" as const,
      marketSlug: target.marketSlug,
      evidence: target.evidence,
      hasProbability: true,
    })),
    ...input.decision.candidateDispositions.map((disposition) => ({
      kind: "DISPOSITION" as const,
      marketSlug: disposition.marketSlug,
      evidence: disposition.evidence,
      reasonCode: disposition.reasonCode,
      hasProbability: disposition.estimatedProbability !== undefined,
    })),
  ];
  const referencedBundleIds = new Set(
    decisionItems.flatMap((item) => {
      const source =
        item.kind === "TARGET"
          ? input.decision.portfolioTargets.find(
              (target) => target.marketSlug === item.marketSlug,
            )
          : input.decision.candidateDispositions.find(
              (disposition) => disposition.marketSlug === item.marketSlug,
            );
      return source?.evidenceBundleIds ?? [];
    }),
  );
  for (const bundle of input.decision.evidenceBundles ?? []) {
    if (referencedBundleIds.has(bundle.id)) continue;
    advisoryIssues.push({
      code: "UNREFERENCED_EVIDENCE_BUNDLE",
      marketSlug: `evidenceBundle:${bundle.id}`,
      message: `Evidence bundle ${bundle.id} is unreferenced and cannot be used to hide unvalidated sources`,
    });
  }

  for (const item of decisionItems) {
    const itemIssueStart = issues.length;
    const market = input.marketsBySlug.get(item.marketSlug);
    if (market === undefined) continue;
    const eventYear = expectedEventYear(market, now);
    const maximumAgeDays = freshnessDays(market, now);
    const currentDomains = new Set<string>();
    for (const evidence of item.evidence) {
      const observed = registry.get(evidence.url);
      if (observed === undefined) {
        issues.push({
          code: "SOURCE_NOT_OBSERVED",
          marketSlug: item.marketSlug,
          url: evidence.url,
          message:
            "The cited URL did not appear in this cycle's web-search output",
        });
        continue;
      }
      let fetched: FetchedEvidencePage | undefined;
      let authoritativeDate = providerDate(observed);
      const searchable = normalizedExcerpt(
        [observed.title, observed.excerpt].filter(Boolean).join(" "),
      );
      const excerpt = evidence.claimExcerpt;
      const needsBody =
        (excerpt !== undefined &&
          !searchable.includes(normalizedExcerpt(excerpt))) ||
        (evidence.evidenceClass === "CURRENT_REPORT" &&
          authoritativeDate === undefined);
      if (needsBody) {
        try {
          const key = canonicalEvidenceUrl(evidence.url);
          let pending = fetchCache.get(key);
          if (pending === undefined) {
            if (fetchCache.size >= 24) {
              throw new Error(
                "Cycle evidence-fetch budget of 24 pages was exhausted",
              );
            }
            pending = fetchEvidencePage(key, {
              ...(input.fetchImplementation === undefined
                ? {}
                : { fetchImplementation: input.fetchImplementation }),
              ...(input.lookupImplementation === undefined
                ? {}
                : { lookupImplementation: input.lookupImplementation }),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            });
            fetchCache.set(key, pending);
          }
          fetched = await pending;
          if (
            authoritativeDate === undefined &&
            fetched.publishedAt !== undefined
          ) {
            authoritativeDate = new Date(fetched.publishedAt);
          }
        } catch (error) {
          issues.push({
            code: "SOURCE_FETCH_FAILED",
            marketSlug: item.marketSlug,
            url: evidence.url,
            message: `The source could not be safely fetched for verification: ${error instanceof Error ? error.message : "unknown failure"}`,
          });
        }
      }
      if (
        excerpt !== undefined &&
        !searchable.includes(normalizedExcerpt(excerpt)) &&
        (fetched === undefined ||
          !normalizedExcerpt(fetched.text).includes(normalizedExcerpt(excerpt)))
      ) {
        issues.push({
          code: "CLAIM_EXCERPT_NOT_FOUND",
          marketSlug: item.marketSlug,
          url: evidence.url,
          message:
            "claimExcerpt was not found in provider evidence or the safely fetched page",
        });
        continue;
      }
      if (
        excerpt !== undefined &&
        (evidence.evidenceClass === "CURRENT_REPORT" ||
          evidence.evidenceClass === "LIVE_DATA")
      ) {
        const unsupportedNumbers = unsupportedEvidenceNumericDetails(
          evidence.relevance,
          excerpt,
          [
            market.title,
            market.slug,
            market.settlementRules,
            String(evidence.claimEventYear ?? ""),
            evidence.publishedAt ?? "",
            evidence.asOf ?? "",
          ].join(" "),
        );
        if (unsupportedNumbers.length > 0) {
          issues.push({
            code: "CLAIM_NUMERIC_DETAIL_UNSUPPORTED",
            marketSlug: item.marketSlug,
            url: evidence.url,
            message: `Numeric fact(s) ${unsupportedNumbers.join(", ")} appear in relevance but not in claimExcerpt`,
          });
          continue;
        }
      }
      if (
        evidence.evidenceClass === "CURRENT_REPORT" ||
        evidence.evidenceClass === "LIVE_DATA"
      ) {
        if (evidence.claimEventYear !== eventYear) {
          issues.push({
            code: "EVENT_YEAR_MISMATCH",
            marketSlug: item.marketSlug,
            url: evidence.url,
            message: `claimEventYear ${String(evidence.claimEventYear)} does not match market event year ${eventYear}`,
          });
          continue;
        }
        if (evidence.evidenceClass === "CURRENT_REPORT") {
          if (authoritativeDate === undefined) {
            issues.push({
              code: "PUBLICATION_DATE_UNVERIFIED",
              marketSlug: item.marketSlug,
              url: evidence.url,
              message: "No authoritative publication date could be derived",
            });
            continue;
          }
          const claimed =
            evidence.publishedAt === undefined
              ? undefined
              : new Date(evidence.publishedAt);
          if (
            claimed === undefined ||
            Math.abs(claimed.getTime() - authoritativeDate.getTime()) >
              86_400_000
          ) {
            issues.push({
              code: "MODEL_DATE_MISMATCH",
              marketSlug: item.marketSlug,
              url: evidence.url,
              message: `Claimed publication date does not match authoritative date ${authoritativeDate.toISOString()}`,
            });
            continue;
          }
        } else {
          authoritativeDate =
            evidence.asOf === undefined ? undefined : new Date(evidence.asOf);
          const observedTime = new Date(observed.observedAt);
          if (
            authoritativeDate === undefined ||
            !liveDataAsOfMatchesObservation(authoritativeDate, observedTime)
          ) {
            issues.push({
              code: "MODEL_DATE_MISMATCH",
              marketSlug: item.marketSlug,
              url: evidence.url,
              message:
                "LIVE_DATA asOf must be within 24 hours of the provider observation; a date-only midnight value may name the immediately preceding UTC date",
            });
            continue;
          }
        }
        if (authoritativeDate.getTime() > now.getTime() + 300_000) {
          issues.push({
            code: "FUTURE_SOURCE",
            marketSlug: item.marketSlug,
            url: evidence.url,
            message: "Authoritative evidence timestamp is in the future",
          });
          continue;
        }
        const ageDays =
          (now.getTime() - authoritativeDate.getTime()) / 86_400_000;
        if (ageDays > maximumAgeDays) {
          issues.push({
            code: "STALE_SOURCE",
            marketSlug: item.marketSlug,
            url: evidence.url,
            message: `Evidence is ${Math.floor(ageDays)} days old; this market allows at most ${maximumAgeDays}`,
          });
          continue;
        }
        if (excerpt !== undefined) {
          const excerptYears = [
            ...excerpt.matchAll(/\b((?:19|20)\d{2})\b/gu),
          ].map((match) => Number(match[1]));
          if (
            !excerptYears.includes(eventYear) &&
            (excerptYears.length > 0 ||
              authoritativeDate.getUTCFullYear() !== eventYear)
          ) {
            issues.push({
              code: "EVENT_YEAR_UNSUPPORTED",
              marketSlug: item.marketSlug,
              url: evidence.url,
              message:
                excerptYears.length > 0
                  ? `The exact claim excerpt names ${[...new Set(excerptYears)].join(", ")} rather than ${eventYear}`
                  : `The exact claim excerpt does not name ${eventYear}, and the source date is from another year`,
            });
            continue;
          }
        }
        currentDomains.add(sourceDomain(observed.url));
      }
      const verifiedSource: VerifiedEvidenceSource = {
        marketSlug: item.marketSlug,
        url: canonicalEvidenceUrl(evidence.url),
        domain: sourceDomain(evidence.url),
        evidenceClass: evidence.evidenceClass ?? "BACKGROUND",
        ...(authoritativeDate === undefined
          ? {}
          : { authoritativeAt: authoritativeDate.toISOString() }),
        expectedEventYear: eventYear,
        freshnessLimitDays: maximumAgeDays,
      };
      const verifiedKey = JSON.stringify([
        verifiedSource.marketSlug,
        verifiedSource.url,
        verifiedSource.evidenceClass,
      ]);
      if (!verifiedKeys.has(verifiedKey)) {
        verifiedKeys.add(verifiedKey);
        verified.push(verifiedSource);
      }
    }
    const sourceIssueEnd = issues.length;
    const hasRequiredCurrentDomains =
      currentDomains.size >= input.minimumIndependentSources;
    if (currentEvidenceRequired(item) && !hasRequiredCurrentDomains) {
      issues.push({
        code: "INSUFFICIENT_CURRENT_DOMAINS",
        marketSlug: item.marketSlug,
        message: `${item.marketSlug} has ${currentDomains.size} verified current domain(s); ${input.minimumIndependentSources} required`,
      });
    }
    const blockingItem =
      item.kind === "TARGET" &&
      (input.blockingTargetMarketSlugs === undefined ||
        input.blockingTargetMarketSlugs.has(item.marketSlug));
    if (
      blockingItem &&
      hasRequiredCurrentDomains &&
      sourceIssueEnd > itemIssueStart
    ) {
      // Once the configured number of current independent domains has been
      // verified, a malformed redundant citation is an audit warning rather
      // than a veto on an otherwise authorized target. The invalid source is
      // excluded from verifiedSources and can never count toward the gate.
      advisoryIssues.push(
        ...issues.splice(itemIssueStart, sourceIssueEnd - itemIssueStart),
      );
    }
    if (!blockingItem && issues.length > itemIssueStart) {
      advisoryIssues.push(...issues.splice(itemIssueStart));
    }
  }

  const verifiedCurrent = verified.filter(
    (source) => source.evidenceClass !== "BACKGROUND",
  );
  return {
    valid: issues.length === 0,
    verifiedSources: verified,
    verifiedCurrentUrls: [
      ...new Set(verifiedCurrent.map((source) => source.url)),
    ],
    independentCurrentDomains: [
      ...new Set(verifiedCurrent.map((source) => source.domain)),
    ],
    advisoryIssues,
    issues,
  };
}
