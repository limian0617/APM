export const QUANTITY_SCALE = 1_000_000n;

export class QuantityError extends Error {
  constructor(
    readonly code:
      "PROC_QUANTITY_INVALID" | "PROC_UNIT_CONVERSION_INVALID" | "PROC_UNIT_CONVERSION_INEXACT",
    message: string
  ) {
    super(message);
    this.name = "QuantityError";
  }
}

export type FrozenUnitConversion = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

const quantityPattern = /^\d{1,12}(?:\.\d{1,6})?$/u;

export function parseQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !quantityPattern.test(value)) {
    throw new QuantityError(
      "PROC_QUANTITY_INVALID",
      "数量必须是非负十进制字符串，整数不超过 12 位且小数不超过 6 位。"
    );
  }
  const [whole, decimal = ""] = value.split(".");
  return BigInt(whole) * QUANTITY_SCALE + BigInt(decimal.padEnd(6, "0"));
}

export function formatQuantity(value: bigint): string {
  if (typeof value !== "bigint" || value < 0n) {
    throw new QuantityError("PROC_QUANTITY_INVALID", "数量必须是非负微单位整数。");
  }
  const whole = value / QUANTITY_SCALE;
  const decimal = (value % QUANTITY_SCALE).toString().padStart(6, "0").replace(/0+$/u, "");
  return decimal ? `${whole}.${decimal}` : whole.toString();
}

export function convertQuantity(value: bigint, conversion: FrozenUnitConversion): bigint {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    typeof conversion?.numerator !== "bigint" ||
    typeof conversion.denominator !== "bigint" ||
    conversion.numerator <= 0n ||
    conversion.denominator <= 0n
  ) {
    throw new QuantityError(
      "PROC_UNIT_CONVERSION_INVALID",
      "单位换算必须使用已冻结的正整数分子和分母。"
    );
  }
  const scaled = value * conversion.numerator;
  if (scaled % conversion.denominator !== 0n) {
    throw new QuantityError(
      "PROC_UNIT_CONVERSION_INEXACT",
      "单位换算不能在百万分之一精度内精确表示。"
    );
  }
  return scaled / conversion.denominator;
}
