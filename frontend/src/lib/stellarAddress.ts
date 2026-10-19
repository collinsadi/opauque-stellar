/**
 * Stellar address validation utilities for StrKey account and contract addresses.
 *
 * Used to validate delegate addresses before transaction submission (issue #1136).
 */

import { StrKey } from "@stellar/stellar-sdk";

export type AddressKind = "account" | "contract" | "invalid";

/**
 * Validate a string as a Stellar StrKey address (account or contract).
 */
export function validateStellarAddress(address: string): AddressKind {
  const trimmed = address.trim();
  if (!trimmed) return "invalid";

  if (StrKey.isValidEd25519PublicKey(trimmed)) return "account";
  if (StrKey.isValidContract(trimmed)) return "contract";
  return "invalid";
}

/**
 * Returns true if the address is a valid account or contract address.
 */
export function isValidStellarAddress(address: string): boolean {
  return validateStellarAddress(address) !== "invalid";
}

/**
 * Returns a human-readable error message for an invalid address, or null if valid.
 */
export function getAddressValidationError(address: string): string | null {
  const kind = validateStellarAddress(address);
  if (kind !== "invalid") return null;

  const trimmed = address.trim();
  if (!trimmed) return "Address is required.";
  if (trimmed.includes("base58")) {
    return "Use a Stellar StrKey address (starts with G for accounts or C for contracts), not a Solana-style base58 address.";
  }
  return "Invalid Stellar address. Must be a G... (account) or C... (contract) StrKey address.";
}
