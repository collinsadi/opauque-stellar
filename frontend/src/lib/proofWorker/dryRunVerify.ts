// Local preflight check before submitting proof on-chain.
// Catches encoding errors without spending fees.

export interface DryRunResult {
  pass: boolean;
  failedSignal?: string;
  message: string;
}

/**
 * Validates proof witness inputs before on-chain submission.
 * Checks that all required signals are present and within BN254 field range.
 */
export function dryRunVerify(
  witnessInputs: Record<string, unknown>,
  requiredSignals: string[],
): DryRunResult {
  const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  for (const signal of requiredSignals) {
    const val = witnessInputs[signal];

    if (val === undefined || val === null) {
      return { pass: false, failedSignal: signal, message: `Missing required signal: ${signal}` };
    }

    // Arrays (merkle_path, merkle_path_indices)
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const n = BigInt(val[i] as string | number);
        if (n < 0n || n >= BN254_FIELD) {
          return {
            pass: false,
            failedSignal: `${signal}[${i}]`,
            message: `Signal ${signal}[${i}] = ${n} is out of BN254 field range`,
          };
        }
      }
      continue;
    }

    // Scalar signals
    try {
      const n = BigInt(val as string | number);
      if (n < 0n || n >= BN254_FIELD) {
        return {
          pass: false,
          failedSignal: signal,
          message: `Signal ${signal} = ${n} is out of BN254 field range`,
        };
      }
    } catch {
      return { pass: false, failedSignal: signal, message: `Signal ${signal} is not a valid integer: ${String(val)}` };
    }
  }

  return { pass: true, message: 'All signals valid — safe to submit on-chain' };
}
