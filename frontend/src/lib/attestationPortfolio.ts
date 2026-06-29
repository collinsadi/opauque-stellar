import type { SchemaV2 } from "./schema";
import type { AttestationV2 } from "./attestationV2";
import type { V2DiscoveredTrait } from "../store/schemaStore";
import type { DiscoveredTrait } from "./reputation";

export interface AttestationPortfolioPayload {
  schemas: SchemaV2[];
  discoveredTraits: V2DiscoveredTrait[];
  attestations: AttestationV2[];
  legacyTraits: DiscoveredTrait[];
  lastScannedSlot: number;
  exportedAt: string;
}

export interface EncryptedAttestationPortfolio {
  type: "opaque.attestation-portfolio";
  version: 1;
  exportedAt: string;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
  };
  cipher: {
    name: "AES-GCM";
    nonce: string;
  };
  salt: string;
  encryptedPayload: string;
}

const PORTFOLIO_VERSION = 1;
const PBKDF2_ITERATIONS = 150_000;
const KEY_LENGTH = 256;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derivePortfolioKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptAttestationPortfolio(
  passphrase: string,
  payload: AttestationPortfolioPayload,
): Promise<EncryptedAttestationPortfolio> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePortfolioKey(passphrase, salt);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));

  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    encoded,
  );

  return {
    type: "opaque.attestation-portfolio",
    version: PORTFOLIO_VERSION,
    exportedAt: payload.exportedAt,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
    },
    cipher: {
      name: "AES-GCM",
      nonce: bytesToBase64(nonce),
    },
    salt: bytesToBase64(salt),
    encryptedPayload: bytesToBase64(new Uint8Array(encrypted)),
  };
}

export async function decryptAttestationPortfolio(
  passphrase: string,
  file: EncryptedAttestationPortfolio,
): Promise<AttestationPortfolioPayload> {
  if (file.type !== "opaque.attestation-portfolio" || file.version !== PORTFOLIO_VERSION) {
    throw new Error("Unsupported attestation portfolio file.");
  }

  const key = await derivePortfolioKey(passphrase, base64ToBytes(file.salt));
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(file.cipher.nonce) },
    key,
    base64ToBytes(file.encryptedPayload),
  ).catch(() => {
    throw new Error("Invalid passphrase or corrupted attestation portfolio.");
  });

  return JSON.parse(new TextDecoder().decode(decrypted)) as AttestationPortfolioPayload;
}

export function downloadAttestationPortfolio(file: EncryptedAttestationPortfolio): void {
  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `opaque-attestations-${date}.opq-attestations.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
