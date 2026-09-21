"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createIdempotencyKey as createPortalIdempotencyKey, PortalIdentifierError } from "../../../src/idempotency";
import { PortalPdfDownloadAction } from "../../../src/portal-download-action";
import { canApprove, CONSENT_VERSION, documentKind, portalCopy, type PortalKind } from "../../../src/review";

function createIdempotencyKey(): string {
  return createPortalIdempotencyKey();
}

type DocumentData = {
  access_state: string;
  business_name: string;
  number: string;
  revision_label: string;
  snapshot: { total_cents?: number; currency?: string; customer?: { name?: string } };
  snapshot_sha256: string;
  pdf_state: string;
  consent_text: string;
  allowed_actions: string[];
};

export default function ReviewDocumentPage() {
  const router = useRouter();
  const [kind, setKind] = useState<PortalKind>("loading");
  const [doc, setDoc] = useState<DocumentData | undefined>();
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>(portalCopy.loading);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/portal/document", { cache: "no-store" });
        const json = (await response.json()) as { data?: DocumentData; error?: { code?: string } };
        if (!response.ok || !json.data) {
          setKind(json.error?.code === "REQUEST_EXPIRED" ? "expired_quote" : "invalid_link");
          setMessage(json.error?.code === "REQUEST_EXPIRED" ? portalCopy.expiredQuote : portalCopy.invalidLink);
          return;
        }
        setDoc(json.data);
        const next = documentKind({
          accessState: json.data.access_state,
          pdfState: json.data.pdf_state,
          allowedActions: json.data.allowed_actions,
        });
        setKind(next);
        if (next === "already_actioned") {
          router.replace("/review/receipt");
        }
        if (next === "expired_quote") {
          setMessage(portalCopy.expiredQuote);
        }
        if (next === "superseded") {
          setMessage(portalCopy.supersededQuote);
        }
      } catch {
        setKind("network_failure");
        setMessage(portalCopy.networkError);
      }
    })();
  }, [router]);

  async function decide(decision: "approve" | "decline") {
    if (!doc) {
      return;
    }
    setBusy(true);
    setKind("submitting");
    try {
      const csrf = sessionStorage.getItem("portal_csrf") ?? "";
      const response = await fetch("/api/portal/decision", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "idempotency-key": createIdempotencyKey(),
        },
        body: JSON.stringify({
          decision,
          signer_name: name,
          consent_version: CONSENT_VERSION,
          consent_accepted: consent,
          snapshot_sha256: doc.snapshot_sha256,
          comment: comment || undefined,
        }),
      });
      const json = (await response.json()) as { error?: { code?: string } };
      if (response.ok) {
        router.replace("/review/receipt");
        return;
      }
      if (json.error?.code === "ALREADY_DECIDED") {
        router.replace("/review/receipt");
        return;
      }
      if (json.error?.code === "REQUEST_EXPIRED") {
        setKind("expired_quote");
        setMessage(portalCopy.expiredQuote);
        return;
      }
      setKind("network_failure");
      setMessage(portalCopy.networkError);
    } catch (error) {
      if (error instanceof PortalIdentifierError) {
        setKind(decision === "approve" ? "confirm_accept" : "confirm_reject");
        setMessage(portalCopy.identifierError);
        return;
      }
      setKind("network_failure");
      setMessage(portalCopy.networkError);
    } finally {
      setBusy(false);
    }
  }

  const pdfReady = doc?.pdf_state === "ready";
  const viewOnly = Boolean(doc && !doc.allowed_actions.includes("approve"));
  const approveEnabled = canApprove(kind === "confirm_accept" ? "quote_ready" : kind, consent, Boolean(pdfReady)) && name.trim().length > 0;

  return (
    <main className="portal">
      <h1>{viewOnly ? portalCopy.invoiceReady : portalCopy.quoteReady}</h1>
      {kind === "loading" || kind === "submitting" ? <p role="status">{kind === "submitting" ? portalCopy.submitting : portalCopy.loading}</p> : null}
      {kind === "expired_quote" ||
      kind === "superseded" ||
      kind === "invalid_link" ||
      kind === "network_failure" ||
      ((kind === "confirm_accept" || kind === "confirm_reject") && message === portalCopy.identifierError) ? (
        <p role="alert">{message}</p>
      ) : null}
      {doc && (kind === "quote_ready" || kind === "invoice_ready" || kind === "pdf_loading" || kind === "pdf_failure" || kind === "confirm_accept" || kind === "confirm_reject") ? (
        <>
          <p>{doc.business_name}</p>
          <p>
            {doc.number} {doc.revision_label}
          </p>
          <p>{doc.snapshot.customer?.name}</p>
          {kind === "pdf_loading" ? <p role="status">{portalCopy.pdfLoading}</p> : null}
          {kind === "pdf_failure" ? <p role="alert">{portalCopy.pdfFailure}</p> : null}
          {pdfReady ? <PortalPdfDownloadAction /> : null}
          {!viewOnly ? (
            <>
          <label>
            {portalCopy.signerName}
            <input value={name} onChange={(event) => setName(event.target.value.slice(0, 120))} />
          </label>
          <label>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            {doc.consent_text || portalCopy.consentLabel}
          </label>
            </>
          ) : null}
          {kind === "confirm_reject" ? (
            <label>
              {portalCopy.commentLabel}
              <textarea maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value.slice(0, 1000))} />
            </label>
          ) : null}
          {kind === "confirm_accept" ? (
            <>
              <p>{portalCopy.confirmAccept}</p>
              <button type="button" disabled={busy || !approveEnabled} onClick={() => void decide("approve")}>
                {portalCopy.approve}
              </button>
            </>
          ) : null}
          {kind === "confirm_reject" ? (
            <>
              <p>{portalCopy.confirmReject}</p>
              <button type="button" disabled={busy} onClick={() => void decide("decline")}>
                {portalCopy.decline}
              </button>
            </>
          ) : null}
          {kind === "quote_ready" || (!viewOnly && (kind === "pdf_loading" || kind === "pdf_failure")) ? (
            <>
              <button type="button" disabled={!approveEnabled || busy} onClick={() => setKind("confirm_accept")}>
                {portalCopy.approve}
              </button>
              <button type="button" disabled={!pdfReady || busy} onClick={() => setKind("confirm_reject")}>
                {portalCopy.decline}
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
