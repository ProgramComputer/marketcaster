import { Decimal } from "decimal.js";
import type { AccountSnapshot } from "../domain/account.js";
import type { ExecutionResult } from "../domain/execution.js";
import type { OrderBook, QuoteLevel, SideBbo } from "../domain/market.js";
import type { OrderPreview } from "../domain/order.js";
import type { Position } from "../domain/position.js";
import type { OutcomeSide, RuntimeMode } from "../domain/primitives.js";
import {
  ExchangeError,
  type PredictionExchange,
} from "../exchanges/exchange.js";
import { reconstructAccount } from "../portfolio/reconstruct.js";
import type { RiskPolicy } from "../risk/policy.js";
import type { ValidatedProposal } from "../risk/validate.js";
import { safeErrorMessage } from "../utilities/redaction.js";
import { canonicalBookLevels, walkCanonicalBook } from "./depth.js";
import {
  createFingerprint,
  type DuplicateFingerprint,
  findLikelyDuplicate,
} from "./idempotency.js";
import { reconcileAmbiguousSubmission } from "./reconcile.js";

export class SafetyGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SafetyGuardError";
  }
}

export type ExecutionJournalPhase =
  | "INTENT"
  | "PRE_SUBMISSION_OUTCOME"
  | "SUBMISSION_OUTCOME"
  | "RECONCILIATION_OUTCOME"
  | "ATTEMPT_OUTCOME";

export class ExecutionJournalError extends Error {
  public constructor(
    public readonly phase: ExecutionJournalPhase,
    public readonly mutationMayHaveOccurred: boolean,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? `: ${safeErrorMessage(cause)}` : "";
    super(`Execution journal ${phase} failed${detail}`, { cause });
    this.name = "ExecutionJournalError";
  }
}

export interface ExecutionAttempt {
  readonly validated: ValidatedProposal;
  readonly preview?: OrderPreview;
  readonly result?: ExecutionResult;
  readonly skippedReason?: string;
  readonly accountAfter?: AccountSnapshot;
}

export interface ExecutionRun {
  readonly attempts: readonly ExecutionAttempt[];
  readonly stoppedForAmbiguity: boolean;
}

export interface ExecutionJournalIntent {
  readonly attemptSequence: number;
  readonly checkedAt: Date;
  readonly submittedAt: Date;
  readonly validated: ValidatedProposal;
  readonly preview: OrderPreview;
  readonly fingerprint: DuplicateFingerprint;
  readonly positionsBefore: readonly Position[];
}

export interface SanitizedExecutionError {
  readonly name: string;
  readonly message: string;
  readonly code?: ExchangeError["code"];
}

interface ExecutionJournalSubmissionBase {
  readonly attemptSequence: number;
  readonly submittedAt: Date;
  readonly observedAt: Date;
  readonly validated: ValidatedProposal;
}

export type ExecutionJournalSubmissionOutcome =
  | (ExecutionJournalSubmissionBase & {
      readonly kind: "NOT_SUBMITTED";
      readonly reason: "ABORTED_BEFORE_SUBMISSION";
    })
  | (ExecutionJournalSubmissionBase & {
      readonly kind: "RETURNED";
      readonly result: ExecutionResult;
    })
  | (ExecutionJournalSubmissionBase & {
      readonly kind: "THREW";
      readonly error: SanitizedExecutionError;
      readonly orderId?: string;
    });

export interface ExecutionJournalReconciliationOutcome {
  readonly attemptSequence: number;
  readonly submittedAt: Date;
  readonly observedAt: Date;
  readonly validated: ValidatedProposal;
  readonly attempted: boolean;
  readonly finalResult: ExecutionResult;
  readonly reconciliationResult?: ExecutionResult;
  readonly reconciliationError?: SanitizedExecutionError;
}

export interface ExecutionJournalAttemptOutcome {
  readonly attemptSequence: number;
  readonly submittedAt: Date;
  readonly observedAt: Date;
  readonly attempt: ExecutionAttempt;
}

export interface ExecutionJournalHooks {
  recordIntent(intent: ExecutionJournalIntent): Promise<void>;
  recordSubmissionOutcome(
    outcome: ExecutionJournalSubmissionOutcome,
  ): Promise<void>;
  recordReconciliationOutcome(
    outcome: ExecutionJournalReconciliationOutcome,
  ): Promise<void>;
  recordAttempt(outcome: ExecutionJournalAttemptOutcome): Promise<void>;
}

export interface ExecuteOrdersInput {
  readonly exchange: PredictionExchange;
  readonly mode: RuntimeMode;
  readonly snapshot: AccountSnapshot;
  readonly riskEquity: Decimal;
  readonly validated: readonly ValidatedProposal[];
  readonly policy: RiskPolicy;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly journal?: ExecutionJournalHooks;
}

function sanitizeExecutionError(error: unknown): SanitizedExecutionError {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: "Unknown execution failure" };
  }
  return {
    name: error.name,
    message: safeErrorMessage(error),
    ...(error instanceof ExchangeError ? { code: error.code } : {}),
  };
}

function ambiguousOrderId(error: unknown): string | undefined {
  return error instanceof ExchangeError &&
    error.code === "AMBIGUOUS_SUBMISSION" &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "orderId" in error.cause &&
    typeof error.cause.orderId === "string"
    ? error.cause.orderId
    : undefined;
}

async function recordJournalEvent(
  phase: ExecutionJournalPhase,
  mutationMayHaveOccurred: boolean,
  operation: (() => Promise<void>) | undefined,
): Promise<void> {
  if (operation === undefined) return;
  try {
    await operation();
  } catch (error) {
    throw new ExecutionJournalError(phase, mutationMayHaveOccurred, error);
  }
}

function safeJournalTimestamp(now: () => Date, fallback: Date): Date {
  try {
    const timestamp = now();
    return Number.isNaN(timestamp.getTime()) ? fallback : timestamp;
  } catch {
    return fallback;
  }
}

async function reconstructAccountAfterMutation(
  exchange: PredictionExchange,
  signal?: AbortSignal,
): Promise<AccountSnapshot> {
  const retryDelaysMilliseconds = [0, 150, 350] as const;
  let lastError: unknown;
  for (const delayMilliseconds of retryDelaysMilliseconds) {
    signal?.throwIfAborted();
    if (delayMilliseconds > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delayMilliseconds),
      );
      signal?.throwIfAborted();
    }
    try {
      return await reconstructAccount(exchange);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function assertPreviewSafe(
  preview: OrderPreview,
  proposal: ValidatedProposal,
  availableBuyingPower: Decimal,
  remainingCycleSpend: Decimal,
): Decimal {
  if (!preview.accepted) {
    throw new SafetyGuardError(
      `Order preview rejected: ${preview.rejectionReasons.join(", ") || "unspecified reason"}`,
    );
  }
  if (preview.warnings.length > 0) {
    throw new SafetyGuardError(
      `Order preview returned fatal warnings: ${preview.warnings.join(", ")}`,
    );
  }
  const limitPrincipal = proposal.order.quantity.mul(
    proposal.order.canonicalLimitPrice,
  );
  const previewPrincipal = preview.estimatedPrincipal;
  const previewFees = preview.estimatedFees;
  if (
    !limitPrincipal.isFinite() ||
    limitPrincipal.lt(0) ||
    (previewPrincipal !== undefined &&
      (!previewPrincipal.isFinite() || previewPrincipal.lt(0))) ||
    !previewFees.isFinite() ||
    previewFees.lt(0) ||
    !proposal.conservativeFeeReserve.isFinite() ||
    proposal.conservativeFeeReserve.lt(0) ||
    !proposal.maximumExecutionSpend.isFinite() ||
    proposal.maximumExecutionSpend.lt(0)
  ) {
    throw new SafetyGuardError(
      "Preview returned invalid principal or fee estimates",
    );
  }
  // A preview may omit principal or report lower fees than deterministic
  // validation reserved. Neither may reduce the already-approved worst case.
  const principal =
    proposal.proposal.action === "BUY"
      ? Decimal.max(limitPrincipal, previewPrincipal ?? 0)
      : (previewPrincipal ?? limitPrincipal);
  const fees = Decimal.max(previewFees, proposal.conservativeFeeReserve);
  const totalCost = principal.plus(fees);
  if (proposal.proposal.action === "BUY") {
    const validatedMaximumExecutionSpend = limitPrincipal.plus(
      proposal.conservativeFeeReserve,
    );
    if (!validatedMaximumExecutionSpend.eq(proposal.maximumExecutionSpend)) {
      throw new SafetyGuardError(
        "Validated maximum execution spend is internally inconsistent",
      );
    }
    if (totalCost.gt(proposal.riskBudget)) {
      throw new SafetyGuardError(
        "Preview cost exceeds the validated risk budget",
      );
    }
    if (totalCost.gt(availableBuyingPower)) {
      throw new SafetyGuardError("Preview cost exceeds fresh buying power");
    }
    const previewPrice = principal.div(proposal.order.quantity);
    const feePerContract = fees.div(proposal.order.quantity);
    const netEdge = proposal.proposal.estimatedProbability
      .minus(previewPrice)
      .minus(feePerContract);
    if (netEdge.lte(0)) {
      throw new SafetyGuardError(
        "Authoritative preview price and fees do not leave positive net edge",
      );
    }
  }
  if (proposal.proposal.action === "SELL" && fees.gte(principal)) {
    throw new SafetyGuardError(
      "Preview fees would consume all conservative exit proceeds",
    );
  }
  if (preview.estimatedCollateral?.gt(totalCost) === true) {
    throw new SafetyGuardError(
      "Preview returned unexpected collateral requirements",
    );
  }
  const cycleSpend = proposal.proposal.action === "BUY" ? totalCost : fees;
  if (cycleSpend.gt(remainingCycleSpend)) {
    throw new SafetyGuardError(
      "Authoritative preview spend exceeds remaining cycle spend headroom",
    );
  }
  return cycleSpend;
}

function assertCanonicalQuoteSane(quote: SideBbo): asserts quote is {
  readonly bid: Decimal;
  readonly ask: Decimal;
  readonly spread?: Decimal;
} {
  if (quote.bid === undefined || quote.ask === undefined) {
    throw new SafetyGuardError("Fresh execution quote is incomplete");
  }
  if (
    !quote.bid.isFinite() ||
    !quote.ask.isFinite() ||
    quote.bid.lt(0) ||
    quote.bid.gt(1) ||
    quote.ask.lt(0) ||
    quote.ask.gt(1)
  ) {
    throw new SafetyGuardError("Fresh execution quote is invalid");
  }
  if (quote.bid.gt(quote.ask)) {
    throw new SafetyGuardError("Execution BBO is crossed");
  }
}

function bestCanonicalPrice(
  levels: readonly QuoteLevel[],
  preferHigher: boolean,
): Decimal | undefined {
  let best: Decimal | undefined;
  for (const level of levels) {
    if (
      !level.price.isFinite() ||
      !level.quantity.isFinite() ||
      level.price.lt(0) ||
      level.price.gt(1) ||
      level.quantity.lte(0)
    ) {
      throw new SafetyGuardError(
        "Execution order book contains an invalid level",
      );
    }
    if (
      best === undefined ||
      (preferHigher ? level.price.gt(best) : level.price.lt(best))
    ) {
      best = level.price;
    }
  }
  return best;
}

function assertCanonicalBookSane(book: OrderBook, side: OutcomeSide): void {
  const bestBid = bestCanonicalPrice(
    canonicalBookLevels(book, side, "SELL"),
    true,
  );
  const bestAsk = bestCanonicalPrice(
    canonicalBookLevels(book, side, "BUY"),
    false,
  );
  if (bestBid !== undefined && bestAsk !== undefined && bestBid.gt(bestAsk)) {
    throw new SafetyGuardError("Execution order book is crossed");
  }
}

async function assertFreshExecutionState(
  exchange: PredictionExchange,
  validated: ValidatedProposal,
  policy: RiskPolicy,
  signal: AbortSignal | undefined,
): Promise<void> {
  const [market, bbo, book] = await Promise.all([
    exchange.getMarketBySlug(validated.market.slug),
    exchange.getBbo(validated.market.id),
    exchange.getOrderBook(validated.market.id),
  ]);
  signal?.throwIfAborted();
  if (!market.active || market.closed || market.archived) {
    throw new SafetyGuardError(
      "Market closed between validation and execution",
    );
  }
  if (
    !market.priceTick.eq(validated.market.priceTick) ||
    !market.minimumTradeQuantity.eq(validated.market.minimumTradeQuantity)
  ) {
    throw new SafetyGuardError(
      "Market tick or minimum quantity changed before execution",
    );
  }
  const quote = validated.order.side === "YES" ? bbo.yes : bbo.no;
  assertCanonicalQuoteSane(quote);
  assertCanonicalBookSane(book, validated.order.side);
  if (
    quote.ask.minus(quote.bid).gt(policy.maximumExecutionSpread) &&
    !(validated.order.action === "SELL" && policy.emergencyExitEnabled)
  ) {
    throw new SafetyGuardError("Execution spread widened beyond policy");
  }
  const top = validated.order.action === "BUY" ? quote.ask : quote.bid;
  if (
    (validated.order.action === "BUY" &&
      top.gt(validated.order.canonicalLimitPrice)) ||
    (validated.order.action === "SELL" &&
      top.lt(validated.order.canonicalLimitPrice))
  ) {
    throw new SafetyGuardError(
      "Fresh price moved beyond the model-approved limit",
    );
  }
  const freshDepth = walkCanonicalBook(
    book,
    validated.order.side,
    validated.order.action,
    validated.order.quantity,
    validated.order.canonicalLimitPrice,
  );
  if (!freshDepth.fullyFillable) {
    throw new SafetyGuardError(
      "Fresh depth cannot fill the validated quantity",
    );
  }
}

function stalePortfolioTargetReason(
  validated: ValidatedProposal,
  positions: readonly Position[],
  freshAccount: AccountSnapshot | undefined,
  expectedSnapshot: AccountSnapshot,
): string | undefined {
  const plan = validated.proposal.portfolioTargetPlan;
  if (plan === undefined) return undefined;
  const currentMatches = positions.filter(
    (position) =>
      position.marketSlug === validated.order.marketSlug &&
      position.side === validated.order.side,
  );
  const oppositeMatches = positions.filter(
    (position) =>
      position.marketSlug === validated.order.marketSlug &&
      position.side !== validated.order.side,
  );
  if (currentMatches.length > 1 || oppositeMatches.length > 1) {
    return "Fresh position state contains duplicate target-market rows";
  }
  const current = currentMatches[0];
  const opposite = oppositeMatches[0];
  const currentCostBasis = current?.costBasis ?? new Decimal(0);
  const currentQuantity = current?.quantity ?? new Decimal(0);
  const currentAvailable = current?.availableQuantity ?? new Decimal(0);
  const oppositeCostBasis = opposite?.costBasis ?? new Decimal(0);
  const oppositeQuantity = opposite?.quantity ?? new Decimal(0);
  const positionsMatchRollingSnapshot =
    positions.length === expectedSnapshot.positions.length &&
    expectedSnapshot.positions.every((expected) => {
      const matches = positions.filter(
        (position) =>
          position.marketSlug === expected.marketSlug &&
          position.side === expected.side,
      );
      const actual = matches[0];
      if (matches.length !== 1 || actual === undefined) return false;
      return (
        actual.marketId.exchange === expected.marketId.exchange &&
        actual.marketId.value === expected.marketId.value &&
        actual.quantity.eq(expected.quantity) &&
        actual.availableQuantity.eq(expected.availableQuantity) &&
        actual.costBasis.eq(expected.costBasis)
      );
    });
  if (
    freshAccount !== undefined &&
    (!freshAccount.currentBalance.eq(expectedSnapshot.currentBalance) ||
      !freshAccount.buyingPower.eq(expectedSnapshot.buyingPower))
  ) {
    return "Fresh account capital changed since portfolio-target reconciliation";
  }
  if (
    !positionsMatchRollingSnapshot ||
    !currentCostBasis.eq(plan.baselineCostBasisUsd) ||
    !currentQuantity.eq(plan.baselineQuantity) ||
    !currentAvailable.eq(plan.baselineAvailableQuantity) ||
    !oppositeCostBasis.eq(plan.baselineOppositeCostBasisUsd) ||
    !oppositeQuantity.eq(plan.baselineOppositeQuantity)
  ) {
    return "Fresh position changed since portfolio-target reconciliation";
  }
  if (
    (validated.order.action === "BUY" &&
      currentCostBasis.gte(plan.targetCostBasisUsd)) ||
    (validated.order.action === "SELL" &&
      currentCostBasis.lte(plan.targetCostBasisUsd))
  ) {
    return "Fresh position already meets or crosses the portfolio target";
  }
  return undefined;
}

export async function executeValidatedOrders(
  input: ExecuteOrdersInput,
): Promise<ExecutionRun> {
  if (input.mode !== "live")
    return { attempts: [], stoppedForAmbiguity: false };
  if (input.snapshot.openOrders.length > 0) {
    throw new SafetyGuardError(
      "Unexpected open orders disable live execution for this cycle",
    );
  }
  if (!input.riskEquity.isFinite() || input.riskEquity.lt(0)) {
    throw new SafetyGuardError("Risk equity is invalid for live execution");
  }
  if (
    !input.policy.maximumCycleSpendFraction.isFinite() ||
    input.policy.maximumCycleSpendFraction.lt(0) ||
    input.policy.maximumCycleSpendFraction.gt(1)
  ) {
    throw new SafetyGuardError("Cycle spend policy is invalid");
  }

  const now = input.now ?? (() => new Date());
  const journal = input.journal;
  const attempts: ExecutionAttempt[] = [];
  let currentSnapshot = input.snapshot;
  const maximumCycleSpend = input.riskEquity.mul(
    input.policy.maximumCycleSpendFraction,
  );
  let committedCycleSpend = new Decimal(0);

  for (const [validatedIndex, validated] of input.validated.entries()) {
    const attemptSequence = validatedIndex + 1;
    input.signal?.throwIfAborted();
    const checkedAt = now();
    try {
      const targetAccount =
        validated.proposal.portfolioTargetPlan === undefined
          ? Promise.resolve(undefined)
          : input.exchange.getAccountSnapshot();
      const [openOrders, positions, activities, freshAccount] =
        await Promise.all([
          input.exchange.getOpenOrders(),
          input.exchange.getPositions(),
          input.exchange.getActivities({
            marketSlug: validated.order.marketSlug,
            createdAfter: new Date(
              checkedAt.getTime() -
                input.policy.duplicateWindowMinutes * 60_000,
            ),
            limit: 100,
            sortOrder: "DESCENDING",
          }),
          targetAccount,
        ]);
      input.signal?.throwIfAborted();
      if (openOrders.length > 0) {
        attempts.push({
          validated,
          skippedReason:
            "Fresh open orders appeared after cycle reconstruction; remaining execution stopped",
        });
        return { attempts, stoppedForAmbiguity: false };
      }
      const staleTargetReason = stalePortfolioTargetReason(
        validated,
        positions,
        freshAccount,
        currentSnapshot,
      );
      if (staleTargetReason !== undefined) {
        attempts.push({ validated, skippedReason: staleTargetReason });
        continue;
      }
      const fingerprint = createFingerprint(
        validated.order,
        checkedAt,
        input.policy.duplicateWindowMinutes,
      );
      const duplicate = findLikelyDuplicate(
        fingerprint,
        openOrders,
        activities.items,
        validated.market.minimumTradeQuantity,
        validated.market.priceTick,
      );
      if (duplicate !== undefined) {
        attempts.push({
          validated,
          skippedReason: `Likely duplicate detected: ${duplicate}`,
        });
        continue;
      }
      if (validated.order.action === "SELL") {
        const current = positions.find(
          (position) =>
            position.marketSlug === validated.order.marketSlug &&
            position.side === validated.order.side,
        );
        if (
          current === undefined ||
          current.availableQuantity.lt(validated.order.quantity)
        ) {
          attempts.push({
            validated,
            skippedReason:
              "Fresh position cannot cover the requested exit quantity",
          });
          continue;
        }
      }

      await assertFreshExecutionState(
        input.exchange,
        validated,
        input.policy,
        input.signal,
      );
      input.signal?.throwIfAborted();
      const preview = await input.exchange.previewImmediateOrder(
        validated.order,
        "PLACEMENT",
      );
      input.signal?.throwIfAborted();
      const previewSpend = assertPreviewSafe(
        preview,
        validated,
        currentSnapshot.buyingPower,
        Decimal.max(0, maximumCycleSpend.minus(committedCycleSpend)),
      );

      const submittedAt = now();
      input.signal?.throwIfAborted();
      committedCycleSpend = committedCycleSpend.plus(previewSpend);
      await recordJournalEvent(
        "INTENT",
        false,
        journal === undefined
          ? undefined
          : () =>
              journal.recordIntent({
                attemptSequence,
                checkedAt,
                submittedAt,
                validated,
                preview,
                fingerprint,
                positionsBefore: positions,
              }),
      );
      if (input.signal?.aborted === true) {
        const observedAt = safeJournalTimestamp(now, submittedAt);
        await recordJournalEvent(
          "PRE_SUBMISSION_OUTCOME",
          false,
          journal === undefined
            ? undefined
            : () =>
                journal.recordSubmissionOutcome({
                  kind: "NOT_SUBMITTED",
                  reason: "ABORTED_BEFORE_SUBMISSION",
                  attemptSequence,
                  submittedAt,
                  observedAt,
                  validated,
                }),
        );
        input.signal.throwIfAborted();
      }

      type PlacementOutcome =
        | { readonly kind: "RETURNED"; readonly result: ExecutionResult }
        | {
            readonly kind: "THREW";
            readonly error: unknown;
            readonly orderId?: string;
          };
      let placement: PlacementOutcome;
      try {
        // Deliberately exactly one call. Never wrap this mutation in a retry helper.
        placement = {
          kind: "RETURNED",
          result: await input.exchange.placeImmediateOrder(validated.order),
        };
      } catch (error) {
        const orderId = ambiguousOrderId(error);
        placement = {
          kind: "THREW",
          error,
          ...(orderId === undefined ? {} : { orderId }),
        };
      }

      const submissionObservedAt = safeJournalTimestamp(now, submittedAt);
      await recordJournalEvent(
        "SUBMISSION_OUTCOME",
        true,
        journal === undefined
          ? undefined
          : () =>
              journal.recordSubmissionOutcome(
                placement.kind === "RETURNED"
                  ? {
                      kind: "RETURNED",
                      attemptSequence,
                      submittedAt,
                      observedAt: submissionObservedAt,
                      validated,
                      result: placement.result,
                    }
                  : {
                      kind: "THREW",
                      attemptSequence,
                      submittedAt,
                      observedAt: submissionObservedAt,
                      validated,
                      error: sanitizeExecutionError(placement.error),
                      ...(placement.orderId === undefined
                        ? {}
                        : { orderId: placement.orderId }),
                    },
              ),
      );

      let result: ExecutionResult;
      let reconciliationAttempted = false;
      let reconciliationResult: ExecutionResult | undefined;
      let reconciliationError: SanitizedExecutionError | undefined;
      if (placement.kind === "THREW") {
        reconciliationAttempted = true;
        try {
          reconciliationResult = await reconcileAmbiguousSubmission({
            exchange: input.exchange,
            order: validated.order,
            ...(placement.orderId === undefined
              ? {}
              : { orderId: placement.orderId }),
            positionsBefore: positions,
            submittedAt,
          });
          result = reconciliationResult;
        } catch (error) {
          reconciliationError = sanitizeExecutionError(error);
          result = {
            status: "AMBIGUOUS",
            ...(placement.orderId === undefined
              ? {}
              : { orderId: placement.orderId }),
            filledQuantity: new Decimal(0),
            fees: new Decimal(0),
            finalState: "UNKNOWN",
            ambiguousReason:
              error instanceof Error
                ? `Submission and reconciliation were ambiguous: ${safeErrorMessage(error)}`
                : "Submission and reconciliation were ambiguous",
          };
        }
      } else {
        result = placement.result;
      }
      if (placement.kind === "RETURNED" && result.status === "AMBIGUOUS") {
        reconciliationAttempted = true;
        const ambiguousResult = result;
        try {
          const reconciled = await reconcileAmbiguousSubmission({
            exchange: input.exchange,
            order: validated.order,
            ...(ambiguousResult.orderId === undefined
              ? {}
              : { orderId: ambiguousResult.orderId }),
            positionsBefore: positions,
            submittedAt,
          });
          reconciliationResult = reconciled;
          if (reconciled.status !== "AMBIGUOUS") {
            result = reconciled;
          }
        } catch (error) {
          reconciliationError = sanitizeExecutionError(error);
          // The returned mutation result remains ambiguous and the run stops below.
        }
      }
      const reconciliationObservedAt = safeJournalTimestamp(
        now,
        submissionObservedAt,
      );
      await recordJournalEvent(
        "RECONCILIATION_OUTCOME",
        true,
        journal === undefined
          ? undefined
          : () =>
              journal.recordReconciliationOutcome({
                attemptSequence,
                submittedAt,
                observedAt: reconciliationObservedAt,
                validated,
                attempted: reconciliationAttempted,
                finalResult: result,
                ...(reconciliationResult === undefined
                  ? {}
                  : { reconciliationResult }),
                ...(reconciliationError === undefined
                  ? {}
                  : { reconciliationError }),
              }),
      );
      try {
        // The mutation is never retried. Account reconstruction is read-only
        // and may briefly observe an exchange consistency gap immediately after
        // a confirmed fill, so retry that read before declaring the otherwise
        // known order outcome ambiguous.
        currentSnapshot = await reconstructAccountAfterMutation(
          input.exchange,
          input.signal,
        );
      } catch (reconstructionError) {
        result = {
          ...result,
          status: "AMBIGUOUS",
          ambiguousReason:
            reconstructionError instanceof Error
              ? `Post-order account reconciliation failed: ${safeErrorMessage(reconstructionError)}`
              : "Post-order account reconciliation failed",
        };
      }
      const attempt: ExecutionAttempt = {
        validated,
        preview,
        result,
        accountAfter: currentSnapshot,
      };
      attempts.push(attempt);
      const attemptObservedAt = safeJournalTimestamp(
        now,
        reconciliationObservedAt,
      );
      await recordJournalEvent(
        "ATTEMPT_OUTCOME",
        true,
        journal === undefined
          ? undefined
          : () =>
              journal.recordAttempt({
                attemptSequence,
                submittedAt,
                observedAt: attemptObservedAt,
                attempt,
              }),
      );
      if (result.status === "AMBIGUOUS") {
        return { attempts, stoppedForAmbiguity: true };
      }
    } catch (error) {
      if (error instanceof ExecutionJournalError) throw error;
      if (input.signal?.aborted === true) input.signal.throwIfAborted();
      attempts.push({
        validated,
        skippedReason:
          error instanceof Error ? error.message : "Unknown execution error",
      });
    }
  }

  return { attempts, stoppedForAmbiguity: false };
}
