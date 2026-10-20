/**
 * Privacy verdict for a claim destination (#1128).
 *
 * A destination only earns a "good for privacy" signal when it is a valid address,
 * differs from the connected wallet, and is not reused by another stealth claim.
 * Reusing one destination across claims links those stealth accounts to each other.
 */
import { isValidStellarAddress } from "./stellarAddress";

export type DestinationVerdict =
  /** Empty or invalid: no verdict is shown. */
  | { kind: "none" }
  /** Same as the connected wallet: links the claim to the user's identity. */
  | { kind: "same-as-main" }
  /** Already used by another claim: links those stealth accounts together. */
  | { kind: "reused" }
  /** Valid, separate from the wallet, and not reused. */
  | { kind: "fresh" };

export function evaluateDestinationPrivacy(opts: {
  destination: string;
  mainWalletAddress: string | undefined;
  /** Destinations entered for the other claims being considered. */
  otherDestinations: readonly string[];
}): DestinationVerdict {
  const trimmed = opts.destination.trim();
  if (!trimmed || !isValidStellarAddress(trimmed)) return { kind: "none" };

  if (opts.mainWalletAddress && trimmed === opts.mainWalletAddress) {
    return { kind: "same-as-main" };
  }

  const reused = opts.otherDestinations.some((other) => other.trim() === trimmed);
  if (reused) return { kind: "reused" };

  return { kind: "fresh" };
}
