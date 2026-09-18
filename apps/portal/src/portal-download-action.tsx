"use client";

import { useRef, useState } from "react";
import { runPortalPdfDownload } from "./portal-download";
import { portalCopy } from "./review";

export function PortalPdfDownloadAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);

  async function download() {
    const outcome = await runPortalPdfDownload({
      inFlight,
      onBusy: (nextBusy) => {
        setBusy(nextBusy);
        if (nextBusy) {
          setError(false);
        }
      },
      assign: (validatedUrl) => {
        window.location.assign(validatedUrl);
      },
    });
    if (outcome === "error") {
      setError(true);
    }
  }

  const statusId = "portal-pdf-download-status";
  const errorId = "portal-pdf-download-error";
  const describedBy = [busy ? statusId : undefined, error ? errorId : undefined]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  return (
    <>
      <p>
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy}
          aria-busy={busy}
          aria-describedby={describedBy || undefined}
        >
          {portalCopy.downloadPdf}
        </button>
      </p>
      {busy ? (
        <p id={statusId} role="status">
          {portalCopy.pdfLoading}
        </p>
      ) : null}
      {error ? (
        <>
          <p id={errorId} role="alert">
            {portalCopy.downloadError}
          </p>
          <p>
            <button type="button" onClick={() => void download()} disabled={busy}>
              {portalCopy.retry}
            </button>
          </p>
        </>
      ) : null}
    </>
  );
}
