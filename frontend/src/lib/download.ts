"use client";

// One way to open a file the API streamed (API_INTEGRATION §9): fetch as a Blob
// with credentials, then open it from an object URL. Signed URLs are never
// stored, and a mock-mode same-origin path cannot be opened by navigation
// (MSW intercepts fetch, not a top-level document request).

/** True when the browser is a phone browser that can share/save a file. */
function canShareFile(file: File): boolean {
  return typeof navigator !== "undefined" && typeof navigator.canShare === "function"
    ? navigator.canShare({ files: [file] })
    : false;
}

/**
 * Open a downloaded file in a new tab. Falls back to a normal download when the
 * popup is blocked, so the action never silently does nothing.
 */
export function openBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    saveBlob(blob, filename);
  }
  // The tab has the URL by now; revoke on the next tick to avoid leaking it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Save a downloaded file (same helper, used when opening is not wanted). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Share a downloaded file on mobile when the platform supports it. */
export async function shareOrSave(blob: Blob, filename: string): Promise<boolean> {
  const file = new File([blob], filename, { type: blob.type || "application/pdf" });
  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch {
      return false;
    }
  }
  saveBlob(blob, filename);
  return false;
}

/** Copy text to the clipboard, reporting whether it worked (copy/wa.me helper). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
