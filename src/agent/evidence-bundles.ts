import { z } from "zod";
import {
  DecisionEvidenceSchema,
  type DecisionEvidence,
} from "./decision-evidence.js";

const EVIDENCE_BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const EvidenceBundleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    EVIDENCE_BUNDLE_ID_PATTERN,
    "Evidence bundle ids may contain letters, numbers, dots, underscores, colons, and hyphens",
  );

export type EvidenceBundleId = z.infer<typeof EvidenceBundleIdSchema>;

export const EvidenceFamilyKeySchema = z.string().trim().min(1).max(500);

export type EvidenceFamilyKey = z.infer<typeof EvidenceFamilyKeySchema>;

export const EvidenceBundleSchema = z
  .object({
    id: EvidenceBundleIdSchema,
    familyKey: EvidenceFamilyKeySchema,
    sources: z.array(DecisionEvidenceSchema).min(1).max(10),
  })
  .strict();

export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

function addDuplicateIdIssues(
  ids: readonly string[],
  context: z.RefinementCtx,
  pathForIndex: (index: number) => readonly PropertyKey[],
  noun: string,
): void {
  const firstIndexById = new Map<string, number>();
  ids.forEach((id, index) => {
    const firstIndex = firstIndexById.get(id);
    if (firstIndex === undefined) {
      firstIndexById.set(id, index);
      return;
    }
    context.addIssue({
      code: "custom",
      path: [...pathForIndex(index)],
      message: `Duplicate ${noun} "${id}"; first declared at index ${firstIndex}`,
    });
  });
}

export const EvidenceBundleCollectionSchema = z
  .array(EvidenceBundleSchema)
  .max(100)
  .superRefine((bundles, context) => {
    addDuplicateIdIssues(
      bundles.map((bundle) => bundle.id),
      context,
      (index) => [index, "id"],
      "evidence bundle id",
    );
  });

export const EvidenceBundleIdsSchema = z
  .array(EvidenceBundleIdSchema)
  .max(20)
  .superRefine((ids, context) => {
    addDuplicateIdIssues(
      ids,
      context,
      (index) => [index],
      "evidence bundle reference",
    );
  });

export type EvidenceBundleIds = z.infer<typeof EvidenceBundleIdsSchema>;

export interface EvidenceBundleReferenceProposal {
  readonly evidenceBundleIds: readonly string[];
  readonly evidence?: readonly DecisionEvidence[];
}

export type EvidenceBundleReferenceIssueCode =
  "DUPLICATE_BUNDLE_ID" | "DUPLICATE_PROPOSAL_BUNDLE_ID" | "MISSING_BUNDLE_ID";

export interface EvidenceBundleReferenceIssue {
  readonly code: EvidenceBundleReferenceIssueCode;
  readonly bundleId: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly proposalIndex?: number;
}

/**
 * Finds collection-wide reference problems without throwing. The returned
 * paths are relative to an agent decision and can be forwarded directly into
 * a Zod superRefine context by the decision-schema integration layer.
 */
export function collectEvidenceBundleReferenceIssues(
  bundles: readonly Pick<EvidenceBundle, "id">[],
  proposals: readonly EvidenceBundleReferenceProposal[],
): readonly EvidenceBundleReferenceIssue[] {
  const issues: EvidenceBundleReferenceIssue[] = [];
  const firstBundleIndexById = new Map<string, number>();

  bundles.forEach((bundle, bundleIndex) => {
    const firstIndex = firstBundleIndexById.get(bundle.id);
    if (firstIndex === undefined) {
      firstBundleIndexById.set(bundle.id, bundleIndex);
      return;
    }
    issues.push({
      code: "DUPLICATE_BUNDLE_ID",
      bundleId: bundle.id,
      message: `Duplicate evidence bundle id "${bundle.id}"; first declared at index ${firstIndex}`,
      path: ["evidenceBundles", bundleIndex, "id"],
    });
  });

  proposals.forEach((proposal, proposalIndex) => {
    const firstReferenceIndexById = new Map<string, number>();
    proposal.evidenceBundleIds.forEach((bundleId, referenceIndex) => {
      const firstReferenceIndex = firstReferenceIndexById.get(bundleId);
      if (firstReferenceIndex === undefined) {
        firstReferenceIndexById.set(bundleId, referenceIndex);
      } else {
        issues.push({
          code: "DUPLICATE_PROPOSAL_BUNDLE_ID",
          bundleId,
          message: `Proposal ${proposalIndex} references evidence bundle "${bundleId}" more than once`,
          path: [
            "proposals",
            proposalIndex,
            "evidenceBundleIds",
            referenceIndex,
          ],
          proposalIndex,
        });
      }

      if (!firstBundleIndexById.has(bundleId)) {
        issues.push({
          code: "MISSING_BUNDLE_ID",
          bundleId,
          message: `Proposal ${proposalIndex} references missing evidence bundle "${bundleId}"`,
          path: [
            "proposals",
            proposalIndex,
            "evidenceBundleIds",
            referenceIndex,
          ],
          proposalIndex,
        });
      }
    });
  });

  return issues;
}

export class EvidenceBundleResolutionError extends Error {
  public override readonly name = "EvidenceBundleResolutionError";

  public constructor(
    public readonly issues: readonly EvidenceBundleReferenceIssue[],
  ) {
    super(issues.map((issue) => issue.message).join("; "));
  }
}

export interface ResolvedProposalEvidence<
  Proposal extends EvidenceBundleReferenceProposal,
> {
  readonly proposal: Proposal;
  readonly evidenceBundles: readonly EvidenceBundle[];
  readonly resolvedEvidence: readonly DecisionEvidence[];
}

/**
 * Resolves all shared evidence for every proposal in deterministic declaration
 * order. Direct proposal evidence is retained first for backwards-compatible
 * migrations, followed by each referenced bundle's sources.
 *
 * Duplicate definitions, duplicate references, and missing references fail
 * closed before any partial result is returned.
 */
export function resolveEvidenceForProposals<
  Proposal extends EvidenceBundleReferenceProposal,
>(
  bundles: readonly EvidenceBundle[],
  proposals: readonly Proposal[],
): readonly ResolvedProposalEvidence<Proposal>[] {
  const issues = collectEvidenceBundleReferenceIssues(bundles, proposals);
  if (issues.length > 0) {
    throw new EvidenceBundleResolutionError(issues);
  }

  const bundleById = new Map(
    bundles.map((bundle) => [bundle.id, bundle] as const),
  );

  return proposals.map((proposal) => {
    const evidenceBundles = proposal.evidenceBundleIds.map((id) => {
      const bundle = bundleById.get(id);
      if (bundle === undefined) {
        throw new TypeError(`Unreachable missing evidence bundle "${id}"`);
      }
      return bundle;
    });
    return {
      proposal,
      evidenceBundles,
      resolvedEvidence: [
        ...(proposal.evidence ?? []),
        ...evidenceBundles.flatMap((bundle) => bundle.sources),
      ],
    };
  });
}
