export type RetryPolicy = {
  baseSeconds: number;
  maximumSeconds: number;
};

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正整数。`);
  }
}

export function retryDelaySeconds(attemptNumber: number, policy: RetryPolicy): number {
  positiveInteger(attemptNumber, "attemptNumber");
  positiveInteger(policy.baseSeconds, "baseSeconds");
  positiveInteger(policy.maximumSeconds, "maximumSeconds");

  const exponent = Math.min(attemptNumber - 1, 52);
  return Math.min(policy.maximumSeconds, policy.baseSeconds * 2 ** exponent);
}

export function nextRetryAt(now: Date, attemptNumber: number, policy: RetryPolicy): Date {
  return new Date(now.getTime() + retryDelaySeconds(attemptNumber, policy) * 1000);
}
