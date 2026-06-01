import { useEffect, useState } from "react";
import {
  probeStorageHealth,
  storageFailureMessage,
  type StorageHealthSnapshot,
} from "../lib/storageHealth";

export function StorageHealthBanner() {
  const [health, setHealth] = useState<StorageHealthSnapshot | null>(null);

  useEffect(() => {
    void probeStorageHealth().then(setHealth);
  }, []);

  if (!health) return null;
  if (health.localStorage && health.indexedDB && health.webCrypto) return null;

  const messages: string[] = [];
  if (!health.localStorage) {
    messages.push(storageFailureMessage("unavailable"));
  }
  if (!health.indexedDB) {
    messages.push(storageFailureMessage("private_mode"));
  }
  if (!health.webCrypto) {
    messages.push("Web Crypto is unavailable. Signing and encryption may fail.");
  }

  return (
    <div
      role="alert"
      className="border-b border-error/30 bg-error/10 px-4 py-2 text-center text-xs text-amber-100"
    >
      {messages[0]}
    </div>
  );
}
