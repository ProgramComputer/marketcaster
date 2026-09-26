import { z } from "zod";

const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Evidence URLs must use HTTP or HTTPS");

/**
 * A CURRENT_REPORT that carries only an observation time (`asOf`) describes
 * live data, so it is classified as LIVE_DATA rather than rejecting the plan.
 * A report with a publication time keeps its class and its checks.
 */
function classifyObservedReportAsLiveData(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const evidence = value as Record<string, unknown>;
  if (
    evidence.evidenceClass === "CURRENT_REPORT" &&
    evidence.asOf !== undefined &&
    evidence.publishedAt === undefined
  ) {
    return { ...evidence, evidenceClass: "LIVE_DATA" };
  }
  return value;
}

/**
 * Canonical evidence attached directly to a proposal or shared through an
 * evidence bundle. Keeping this schema independent from the complete decision
 * schema lets both representations use exactly the same validation semantics.
 */
export const DecisionEvidenceSchema = z.preprocess(
  classifyObservedReportAsLiveData,
  z
    .object({
      title: z.string().trim().min(1).max(500),
      url: HttpUrlSchema,
      evidenceClass: z
        .enum(["CURRENT_REPORT", "LIVE_DATA", "BACKGROUND"])
        .optional(),
      claimExcerpt: z.string().trim().min(1).max(2_000).optional(),
      claimEventYear: z
        .number()
        .int()
        .min(1900)
        .max(2200)
        .nullable()
        .optional(),
      publishedAt: z.iso.datetime({ offset: true }).optional(),
      asOf: z.iso.datetime({ offset: true }).optional(),
      relevance: z.string().trim().min(1).max(2000),
    })
    .strict()
    .superRefine((evidence, context) => {
      if (evidence.evidenceClass === "CURRENT_REPORT") {
        if (evidence.publishedAt === undefined) {
          context.addIssue({
            code: "custom",
            path: ["publishedAt"],
            message: "CURRENT_REPORT evidence requires publishedAt",
          });
        }
        if (evidence.asOf !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["asOf"],
            message: "CURRENT_REPORT evidence cannot set asOf",
          });
        }
      }
      if (evidence.evidenceClass === "LIVE_DATA") {
        if (evidence.asOf === undefined) {
          context.addIssue({
            code: "custom",
            path: ["asOf"],
            message: "LIVE_DATA evidence requires asOf",
          });
        }
        if (evidence.publishedAt !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["publishedAt"],
            message: "LIVE_DATA evidence cannot set publishedAt",
          });
        }
      }
      if (
        evidence.evidenceClass === "CURRENT_REPORT" ||
        evidence.evidenceClass === "LIVE_DATA"
      ) {
        if (evidence.claimExcerpt === undefined) {
          context.addIssue({
            code: "custom",
            path: ["claimExcerpt"],
            message: "Current evidence requires an exact claimExcerpt",
          });
        }
        if (
          evidence.claimEventYear === undefined ||
          evidence.claimEventYear === null
        ) {
          context.addIssue({
            code: "custom",
            path: ["claimEventYear"],
            message: "Current evidence requires claimEventYear",
          });
        }
      }
    }),
);

export type DecisionEvidence = z.infer<typeof DecisionEvidenceSchema>;
