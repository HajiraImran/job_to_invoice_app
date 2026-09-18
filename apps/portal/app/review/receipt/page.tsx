"use client";

import { useEffect, useState } from "react";
import { PortalPdfDownloadAction } from "../../../src/portal-download-action";
import { portalCopy } from "../../../src/review";

type ReceiptData = {
  decision: string | null;
  decided_at: string | null;
  number: string;
  revision_label: string;
  payment_claimed: boolean;
};

export default function ReviewReceiptPage() {
  const [loading, setLoading] = useState(true);
  const [receipt, setReceipt] = useState<ReceiptData | undefined>();
  const [message, setMessage] = useState<string>(portalCopy.loading);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/portal/receipt", { cache: "no-store" });
        const json = (await response.json()) as { data?: ReceiptData; error?: { code?: string } };
        if (!response.ok || !json.data) {
          setMessage(json.error?.code === "ALREADY_DECIDED" ? portalCopy.alreadyActioned : portalCopy.invalidLink);
          setLoading(false);
          return;
        }
        setReceipt(json.data);
      } catch {
        setMessage(portalCopy.networkError);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <main className="portal">
      <h1>{portalCopy.appName}</h1>
      {loading ? <p role="status">{portalCopy.loading}</p> : null}
      {!loading && !receipt ? <p role="alert">{message}</p> : null}
      {receipt ? (
        <>
          <p role="status">{receipt.decision === "approve" ? portalCopy.accepted : portalCopy.rejected}</p>
          <p>
            {receipt.number} {receipt.revision_label}
          </p>
          {receipt.decided_at ? <p>{receipt.decided_at}</p> : null}
          <PortalPdfDownloadAction />
        </>
      ) : null}
    </main>
  );
}
