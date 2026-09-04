/** A `type: 'file'` field's value is always this JSON-encoded, whether the
 *  field picks one file (a single object) or several (an array of these). */
export interface PickedFile {
  name: string;
  dataUrl: string;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Parses a `type: 'file'` field's stored value back into one or more picked
 *  files, regardless of whether it was a single- or multiple-file field. */
export function parsePickedFiles(raw: string | undefined): PickedFile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Decodes a data: URL's payload as UTF-8 text (not `atob` alone, which
 *  returns Latin1 and mangles anything outside ASCII). */
export function dataUrlToText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
