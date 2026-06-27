import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import JSZip from "jszip";

type BrandingAsset = {
  id: string;
  name: string;
  filename: string;
  mimeType: string;
  content: string;
  previewSrc: string;
  sizeLabel: string;
};

const ICON_SIZES = [16, 32, 64, 128, 256] as const;

function triggerDownload(filename: string, href: string) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function svgToPngDataUrl(svgContent: string, size: number): Promise<string> {
  const svgBlob = new Blob([svgContent], { type: "image/svg+xml" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = svgUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create canvas context.");
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(image, 0, 0, size, size);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createWordmarkSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160" viewBox="0 0 600 160">',
    '  <rect width="600" height="160" fill="#07080d"/>',
    '  <text x="56" y="106" fill="#ffffff" font-size="84" font-weight="800" font-family="Syne, Arial, sans-serif">Opaque</text>',
    '  <circle cx="452" cy="95" r="10" fill="#5eead4"/>',
    "</svg>",
  ].join("\n");
}

function createOgImageSvgs(): BrandingAsset[] {
  const base = 'xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"';

  const ogA = [
    `<svg ${base}>`,
    '  <defs>',
    '    <linearGradient id="bgA" x1="0%" y1="0%" x2="100%" y2="100%">',
    '      <stop offset="0%" stop-color="#07080d"/>',
    '      <stop offset="100%" stop-color="#0f172a"/>',
    "    </linearGradient>",
    '    <radialGradient id="glowA" cx="78%" cy="18%" r="48%">',
    '      <stop offset="0%" stop-color="#5eead4" stop-opacity="0.28"/>',
    '      <stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>',
    "    </radialGradient>",
    "  </defs>",
    '  <rect width="1200" height="630" fill="url(#bgA)"/>',
    '  <rect width="1200" height="630" fill="url(#glowA)"/>',
    '  <rect x="80" y="80" width="1040" height="470" rx="32" fill="none" stroke="#1f2937"/>',
    '  <text x="120" y="290" fill="#ffffff" font-size="120" font-weight="800" font-family="Syne, Arial, sans-serif">Opaque</text>',
    '  <circle cx="700" cy="273" r="13" fill="#5eead4"/>',
    '  <text x="120" y="360" fill="#94a3b8" font-size="34" font-weight="500" font-family="DM Sans, Arial, sans-serif">Stealth Address Wallet & Privacy Protocol</text>',
    '  <text x="120" y="430" fill="#5eead4" font-size="25" font-weight="600" font-family="DM Sans, Arial, sans-serif">Stellar • Testnet • ZK-ready</text>',
    "</svg>",
  ].join("\n");

  const ogB = [
    `<svg ${base}>`,
    '  <defs>',
    '    <linearGradient id="bgB" x1="0%" y1="0%" x2="100%" y2="100%">',
    '      <stop offset="0%" stop-color="#030712"/>',
    '      <stop offset="100%" stop-color="#111827"/>',
    "    </linearGradient>",
    '    <linearGradient id="lineB" x1="0%" y1="0%" x2="100%" y2="0%">',
    '      <stop offset="0%" stop-color="#5eead4" stop-opacity="0"/>',
    '      <stop offset="45%" stop-color="#5eead4" stop-opacity="0.7"/>',
    '      <stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>',
    "    </linearGradient>",
    "  </defs>",
    '  <rect width="1200" height="630" fill="url(#bgB)"/>',
    '  <g stroke="#1f2937" stroke-width="1">',
    '    <line x1="0" y1="120" x2="1200" y2="120"/>',
    '    <line x1="0" y1="240" x2="1200" y2="240"/>',
    '    <line x1="0" y1="360" x2="1200" y2="360"/>',
    '    <line x1="0" y1="480" x2="1200" y2="480"/>',
    '  </g>',
    '  <line x1="80" y1="148" x2="1120" y2="148" stroke="url(#lineB)" stroke-width="4"/>',
    '  <text x="94" y="316" fill="#ffffff" font-size="128" font-weight="800" font-family="Syne, Arial, sans-serif">Opaque</text>',
    '  <circle cx="678" cy="300" r="13" fill="#5eead4"/>',
    '  <text x="94" y="388" fill="#cbd5e1" font-size="36" font-weight="500" font-family="DM Sans, Arial, sans-serif">Private payments on Stellar</text>',
    '  <text x="94" y="520" fill="#5eead4" font-size="24" font-weight="600" font-family="JetBrains Mono, monospace">opaque.cash</text>',
    "</svg>",
  ].join("\n");

  const ogC = [
    `<svg ${base}>`,
    '  <defs>',
    '    <linearGradient id="bgC" x1="0%" y1="0%" x2="100%" y2="100%">',
    '      <stop offset="0%" stop-color="#0f172a"/>',
    '      <stop offset="100%" stop-color="#020617"/>',
    "    </linearGradient>",
    '    <linearGradient id="cardC" x1="0%" y1="0%" x2="100%" y2="100%">',
    '      <stop offset="0%" stop-color="#0b1223"/>',
    '      <stop offset="100%" stop-color="#111827"/>',
    "    </linearGradient>",
    "  </defs>",
    '  <rect width="1200" height="630" fill="url(#bgC)"/>',
    '  <rect x="120" y="92" width="960" height="446" rx="36" fill="url(#cardC)" stroke="#1f2937" stroke-width="2"/>',
    '  <circle cx="190" cy="162" r="6" fill="#5eead4"/>',
    '  <circle cx="220" cy="162" r="6" fill="#334155"/>',
    '  <circle cx="250" cy="162" r="6" fill="#334155"/>',
    '  <text x="190" y="320" fill="#ffffff" font-size="116" font-weight="800" font-family="Syne, Arial, sans-serif">Opaque</text>',
    '  <circle cx="747" cy="304" r="13" fill="#5eead4"/>',
    '  <text x="190" y="386" fill="#94a3b8" font-size="34" font-weight="500" font-family="DM Sans, Arial, sans-serif">Stealth receive addresses. Unlinkable transfers.</text>',
    '  <text x="190" y="456" fill="#5eead4" font-size="24" font-weight="600" font-family="DM Sans, Arial, sans-serif">Built on EIP-5564</text>',
    "</svg>",
  ].join("\n");

  // Same minimal system as OG 01: gradient + soft teal glow + frame + Opaque wordmark + two lines of copy.
  const ogD = [
    `<svg ${base}>`,
    '  <defs>',
    '    <linearGradient id="bgD" x1="0%" y1="0%" x2="100%" y2="100%">',
    '      <stop offset="0%" stop-color="#07080d"/>',
    '      <stop offset="100%" stop-color="#0f172a"/>',
    "    </linearGradient>",
    '    <radialGradient id="glowD" cx="78%" cy="18%" r="48%">',
    '      <stop offset="0%" stop-color="#5eead4" stop-opacity="0.28"/>',
    '      <stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>',
    "    </radialGradient>",
    "  </defs>",
    '  <rect width="1200" height="630" fill="url(#bgD)"/>',
    '  <rect width="1200" height="630" fill="url(#glowD)"/>',
    '  <rect x="80" y="80" width="1040" height="470" rx="32" fill="none" stroke="#1f2937"/>',
    '  <text x="120" y="290" fill="#ffffff" font-size="120" font-weight="800" font-family="Syne, Arial, sans-serif">Opaque</text>',
    '  <circle cx="700" cy="273" r="13" fill="#5eead4"/>',
    '  <text x="120" y="360" fill="#94a3b8" font-size="34" font-weight="500" font-family="DM Sans, Arial, sans-serif">Programmable Stealth Reputations</text>',
    '  <text x="120" y="430" fill="#5eead4" font-size="25" font-weight="600" font-family="DM Sans, Arial, sans-serif">Groth16 · Merkle roots · Nullifiers</text>',
    "</svg>",
  ].join("\n");

  return [
    {
      id: "og-a",
      name: "OG Image 01 (Modern Gradient)",
      filename: "opaque-og-modern-01.svg",
      mimeType: "image/svg+xml",
      content: ogA,
      previewSrc: svgToDataUrl(ogA),
      sizeLabel: "1200x630",
    },
    {
      id: "og-b",
      name: "OG Image 02 (Modern Grid)",
      filename: "opaque-og-modern-02.svg",
      mimeType: "image/svg+xml",
      content: ogB,
      previewSrc: svgToDataUrl(ogB),
      sizeLabel: "1200x630",
    },
    {
      id: "og-c",
      name: "OG Image 03 (Modern Card)",
      filename: "opaque-og-modern-03.svg",
      mimeType: "image/svg+xml",
      content: ogC,
      previewSrc: svgToDataUrl(ogC),
      sizeLabel: "1200x630",
    },
    {
      id: "og-d",
      name: "OG Image 04 (Programmable Stealth Reputations)",
      filename: "opaque-og-psr.svg",
      mimeType: "image/svg+xml",
      content: ogD,
      previewSrc: svgToDataUrl(ogD),
      sizeLabel: "1200x630",
    },
  ];
}

export function BrandingPage() {
  const [assets, setAssets] = useState<BrandingAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [zipLoading, setZipLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assetCount = useMemo(() => assets.length, [assets]);

  useEffect(() => {
    const loadAssets = async () => {
      setLoading(true);
      setError(null);
      try {
        const faviconResponse = await fetch("/favicon.svg");
        if (!faviconResponse.ok) {
          throw new Error("Could not load /favicon.svg");
        }
        const faviconSvg = await faviconResponse.text();
        const wordmarkSvg = createWordmarkSvg();
        const ogAssets = createOgImageSvgs();

        const builtAssets: BrandingAsset[] = [
          {
            id: "favicon-svg",
            name: "Favicon (SVG)",
            filename: "opaque-favicon.svg",
            mimeType: "image/svg+xml",
            content: faviconSvg,
            previewSrc: svgToDataUrl(faviconSvg),
            sizeLabel: "Vector",
          },
          {
            id: "wordmark-svg",
            name: "Wordmark (SVG)",
            filename: "opaque-wordmark.svg",
            mimeType: "image/svg+xml",
            content: wordmarkSvg,
            previewSrc: svgToDataUrl(wordmarkSvg),
            sizeLabel: "600x160",
          },
        ];

        const generatedIconAssets = await Promise.all(
          ICON_SIZES.map(async (size) => {
            const pngDataUrl = await svgToPngDataUrl(faviconSvg, size);
            return {
              id: `favicon-${size}`,
              name: `Favicon PNG ${size}x${size}`,
              filename: `opaque-favicon-${size}x${size}.png`,
              mimeType: "image/png",
              content: pngDataUrl,
              previewSrc: pngDataUrl,
              sizeLabel: `${size}x${size}`,
            } as BrandingAsset;
          })
        );

        setAssets([...builtAssets, ...generatedIconAssets, ...ogAssets]);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to build branding assets.";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    void loadAssets();
  }, []);

  const onDownloadAsset = (asset: BrandingAsset) => {
    if (asset.mimeType === "image/svg+xml") {
      const blob = new Blob([asset.content], { type: asset.mimeType });
      const url = URL.createObjectURL(blob);
      triggerDownload(asset.filename, url);
      URL.revokeObjectURL(url);
      return;
    }
    triggerDownload(asset.filename, asset.content);
  };

  const onDownloadZip = async () => {
    if (assets.length === 0) return;
    setZipLoading(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder("opaque-branding");
      if (!folder) throw new Error("Failed to create zip folder.");

      for (const asset of assets) {
        if (asset.mimeType === "image/svg+xml") {
          folder.file(asset.filename, asset.content);
        } else {
          folder.file(asset.filename, dataUrlToBytes(asset.content));
        }
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      triggerDownload("opaque-branding-assets.zip", url);
      URL.revokeObjectURL(url);
    } finally {
      setZipLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-ink-950 bg-grid-fade bg-size-grid text-white px-5 sm:px-8 py-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-white">Branding</p>
            <h1 className="mt-2 font-display text-4xl font-bold text-white sm:text-5xl">
              Opaque brand assets
            </h1>
            <p className="mt-3 max-w-2xl text-mist">
              Download official icon, wordmark, and 4 clean modern OG image variations (including Programmable Stealth Reputations). Includes favicon source and PNG exports in common sizes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onDownloadZip}
              disabled={zipLoading || loading || assets.length === 0}
              className="rounded-xl bg-sol-gradient border border-transparent px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            >
              {zipLoading ? "Building ZIP..." : "Download ZIP"}
            </button>
            <Link
              to="/"
              className="rounded-xl border border-ink-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:border-white/40 hover:text-white"
            >
              Back
            </Link>
          </div>
        </div>

        <div className="mb-6 rounded-2xl border border-ink-700 bg-ink-900/30 p-4 text-sm text-mist">
          {loading && "Preparing branding files..."}
          {!loading && error && <span className="text-neutral-300">Error: {error}</span>}
          {!loading && !error && `${assetCount} assets ready`}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((asset) => (
            <article
              key={asset.id}
              className="rounded-2xl border border-ink-700 bg-ink-900/30 p-5"
            >
              <div className="mb-4 flex min-h-[130px] items-center justify-center rounded-xl border border-ink-700 bg-ink-950/60 p-4">
                <img
                  src={asset.previewSrc}
                  alt={asset.name}
                  className={
                    asset.id === "wordmark-svg"
                      ? "h-auto w-full max-w-[220px]"
                      : asset.id.startsWith("og-")
                      ? "h-auto w-full max-w-[320px] rounded-md"
                      : "h-16 w-16"
                  }
                />
              </div>
              <p className="font-display text-base font-semibold text-white">{asset.name}</p>
              <p className="mt-1 text-xs text-mist">{asset.sizeLabel}</p>
              <p className="mt-1 text-xs font-mono text-mist">{asset.filename}</p>
              <button
                type="button"
                onClick={() => onDownloadAsset(asset)}
                className="mt-4 w-full rounded-lg border border-ink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-white/40 hover:text-white"
              >
                Download
              </button>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
