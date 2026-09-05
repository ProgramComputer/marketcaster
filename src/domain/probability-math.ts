// Probability recurrences with caller-supplied inputs; these functions do not select forecasts.
export function tableTennisSetComplete(
  leftPoints: number,
  rightPoints: number,
): boolean {
  return (
    Math.max(leftPoints, rightPoints) >= 11 &&
    Math.abs(leftPoints - rightPoints) >= 2
  );
}

export function tableTennisSetWinProbability(
  leftPoints: number,
  rightPoints: number,
  leftPointWinProbability = 0.5,
): number {
  if (tableTennisSetComplete(leftPoints, rightPoints)) {
    return leftPoints > rightPoints ? 1 : 0;
  }

  const pointProbability = Math.min(1, Math.max(0, leftPointWinProbability));
  if (leftPoints >= 10 && rightPoints >= 10) {
    const leftTwoPoints = pointProbability * pointProbability;
    const rightTwoPoints = (1 - pointProbability) ** 2;
    const denominator = leftTwoPoints + rightTwoPoints;
    const deuceProbability =
      denominator === 0 ? pointProbability : leftTwoPoints / denominator;
    if (leftPoints === rightPoints) return deuceProbability;
    if (leftPoints === rightPoints + 1) {
      return pointProbability + (1 - pointProbability) * deuceProbability;
    }
    if (rightPoints === leftPoints + 1) {
      return pointProbability * deuceProbability;
    }
  }

  const memo = new Map<string, number>();
  const visit = (left: number, right: number): number => {
    if (tableTennisSetComplete(left, right)) return left > right ? 1 : 0;
    if (left >= 10 && right >= 10) {
      if (left === right)
        return tableTennisSetWinProbability(left, right, pointProbability);
      if (left === right + 1) {
        return (
          pointProbability + (1 - pointProbability) * deuceProbabilityAtTie()
        );
      }
      if (right === left + 1) {
        return pointProbability * deuceProbabilityAtTie();
      }
    }
    const key = `${left}:${right}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const probability =
      pointProbability * visit(left + 1, right) +
      (1 - pointProbability) * visit(left, right + 1);
    memo.set(key, probability);
    return probability;
  };
  const deuceProbabilityAtTie = (): number => {
    const leftTwoPoints = pointProbability * pointProbability;
    const rightTwoPoints = (1 - pointProbability) ** 2;
    const denominator = leftTwoPoints + rightTwoPoints;
    return denominator === 0 ? pointProbability : leftTwoPoints / denominator;
  };
  return visit(leftPoints, rightPoints);
}

export function firstToThreeMatchWinProbability(
  leftSets: number,
  rightSets: number,
  leftSetWinProbability = 0.5,
): number {
  if (leftSets >= 3) return 1;
  if (rightSets >= 3) return 0;
  return (
    leftSetWinProbability *
      firstToThreeMatchWinProbability(
        leftSets + 1,
        rightSets,
        leftSetWinProbability,
      ) +
    (1 - leftSetWinProbability) *
      firstToThreeMatchWinProbability(
        leftSets,
        rightSets + 1,
        leftSetWinProbability,
      )
  );
}

export function inverseMonotonicProbability(
  targetProbability: number,
  evaluate: (input: number) => number,
): number {
  const target = Math.min(1, Math.max(0, targetProbability));
  if (target === 0 || target === 1) return target;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (evaluate(midpoint) < target) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}
