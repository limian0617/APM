export function observeSafely(operation: () => void): void {
  try {
    operation();
  } catch {
    // Telemetry must never change the business outcome.
  }
}
