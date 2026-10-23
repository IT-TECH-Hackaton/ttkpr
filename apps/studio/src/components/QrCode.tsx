import QRCode from "qrcode";
import { useEffect, useState } from "react";

interface Props {
  value: string;
  size?: number;
  className?: string;
  label?: string;
}

/** SVG QR code generated locally (the URL never leaves the browser). */
export function QrCode({ value, size = 220, className, label }: Props) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let alive = true;
    void QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then((s) => {
      if (alive) setSvg(s);
    });
    return () => {
      alive = false;
    };
  }, [value]);
  return (
    <div
      role="img"
      aria-label={label ?? "QR-код"}
      className={className}
      style={{ width: size, height: size }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced by the qrcode library from our own URL
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export async function downloadQrPng(value: string, fileName: string) {
  const url = await QRCode.toDataURL(value, { width: 1024, margin: 2, errorCorrectionLevel: "M" });
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  link.click();
}

export async function downloadQrSvg(value: string, fileName: string) {
  const svg = await QRCode.toString(value, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  link.click();
  URL.revokeObjectURL(url);
}
