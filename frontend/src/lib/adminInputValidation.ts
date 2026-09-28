import { StrKey } from "@stellar/stellar-sdk";

export function isValidAdminAddress(value: string): boolean {
  const address = value.trim();
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address);
}
