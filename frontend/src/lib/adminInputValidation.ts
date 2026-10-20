import { StrKey } from "@stellar/stellar-sdk";

export function isValidAdminAddress(value: string): boolean {
  const address = value.trim();
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address);
}

/**
 * A contract (C…) recipient only holds an admin slot usefully if its own
 * authorization logic can sign admin calls. If it cannot, the slot is locked
 * permanently, so these transfers need an explicit acknowledgment and a typed
 * confirmation before they are submitted.
 */
export function transferNeedsStrongConfirmation(value: string): boolean {
  return StrKey.isValidContract(value.trim());
}
