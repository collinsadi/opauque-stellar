/**
 * Wallet hook compatibility for legacy UI components pending full Soroban port.
 *
 * NOTE: publicKey is a plain Stellar address string (G…). Do NOT wrap it in
 * an object with .toBase58() — use the string value directly.
 */

import { useWallet as useStellarWallet } from "../hooks/useWallet";

export function useWallet() {
  const w = useStellarWallet();
  return {
    ...w,
    sendTransaction: async (tx: { toXDR?: () => string }) => {
      if (tx?.toXDR && w.signTransaction) {
        const xdr = tx.toXDR();
        const signed = await w.signTransaction(xdr);
        return { serialize: () => Buffer.from(signed) };
      }
      throw new Error("Use Stellar signTransaction(xdr) flow");
    },
  };
}

export function useConnection() {
  return { connection: null };
}
