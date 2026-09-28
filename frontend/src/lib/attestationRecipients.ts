export function isMetaAddressRecipient(input: string): boolean {
  const trimmed = input.trim().replace(/^0x/i, "");
  return /^[0-9a-fA-F]{132}$/.test(trimmed);
}

export function recipientDiscoveryMessage(announcementPublished: boolean): string {
  return announcementPublished
    ? "The recipient's scanner can discover this attestation on its next scan."
    : "The attestation is on chain. Tell the recipient out of band so they can look for it.";
}
