/** Trigger a browser download of a text blob. UI-only side effect. */
export function downloadText(filename: string, contents: string, mime = "text/plain"): void {
  downloadBlob(filename, new Blob([contents], { type: mime }));
}

/** Trigger a browser download of binary data (e.g. a zip). UI-only side effect. */
export function downloadBlob(filename: string, data: Blob | Uint8Array, mime = "application/octet-stream"): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
