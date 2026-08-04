'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/**
 * Renders a QR code for the given text (e.g. identity-link deep link).
 */
export function QrCodeImage({
  value,
  size = 220,
  className = '',
  alt = 'QR code',
}: {
  value: string;
  size?: number;
  className?: string;
  alt?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setError(null);
    if (!value) return;
    void QRCode.toDataURL(value, {
      width: size,
      margin: 2,
      color: { dark: '#0a0a0a', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (error) {
    return (
      <p className="text-xs text-red-400" role="alert">
        Could not render QR: {error}
      </p>
    );
  }

  if (!dataUrl) {
    return (
      <div
        className={`animate-pulse rounded-lg bg-canvas ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt={alt}
      className={`rounded-lg bg-white p-2 ${className}`}
    />
  );
}
