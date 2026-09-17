"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { accessStateKind, portalCopy, readFragmentToken, type PortalKind } from "../../src/review";

type ExchangeData = {
  access_state: string;
  business_name: string;
  document_type: string;
  recipient_email_masked: string;
  csrf_token: string | null;
};

export default function ReviewAccessPage() {
  const router = useRouter();
  const [kind, setKind] = useState<PortalKind>("loading");
  const [message, setMessage] = useState<string>(portalCopy.loading);
  const [meta, setMeta] = useState<ExchangeData | undefined>();
  const [csrf, setCsrf] = useState<string>("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = readFragmentToken(window.location.hash);
    window.history.replaceState(null, "", "/review");
    if (!token) {
      setKind("invalid_link");
      setMessage(portalCopy.invalidLink);
      return;
    }
    void (async () => {
      try {
        const response = await fetch("/api/portal/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const json = (await response.json()) as { data?: ExchangeData; error?: { code?: string; message?: string } };
        if (!response.ok || !json.data) {
          const next = json.error?.code === "REQUEST_EXPIRED" ? "expired_quote" : "invalid_link";
          setKind(next);
          setMessage(next === "expired_quote" ? portalCopy.expiredQuote : portalCopy.invalidLink);
          return;
        }
        sessionStorage.setItem("portal_csrf", json.data.csrf_token ?? "");
        setCsrf(json.data.csrf_token ?? "");
        setMeta(json.data);
        const next = accessStateKind(json.data.access_state);
        setKind(next);
        if (next === "expired_quote") {
          setMessage(portalCopy.expiredQuote);
        } else if (next === "superseded") {
          setMessage(portalCopy.supersededQuote);
        } else if (next === "already_actioned") {
          router.replace("/review/receipt");
        } else if (next === "invalid_link") {
          setMessage(portalCopy.invalidLink);
        }
      } catch {
        setKind("network_failure");
        setMessage(portalCopy.networkError);
      }
    })();
  }, [router]);

  async function sendCode() {
    setBusy(true);
    try {
      const response = await fetch("/api/portal/code/send", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf || sessionStorage.getItem("portal_csrf") || "" },
        body: "{}",
      });
      if (response.status === 429) {
        setKind("too_many_attempts");
        setMessage(portalCopy.tooManyAttempts);
        return;
      }
      if (!response.ok) {
        setKind("network_failure");
        setMessage(portalCopy.networkError);
        return;
      }
      setKind("code_sent");
    } catch {
      setKind("network_failure");
      setMessage(portalCopy.networkError);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setBusy(true);
    try {
      const response = await fetch("/api/portal/code/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf || sessionStorage.getItem("portal_csrf") || "" },
        body: JSON.stringify({ code }),
      });
      const json = (await response.json()) as { data?: { csrf_token?: string }; error?: { code?: string; message?: string } };
      if (response.ok && json.data?.csrf_token) {
        sessionStorage.setItem("portal_csrf", json.data.csrf_token);
        router.replace("/review/document");
        return;
      }
      if (json.error?.code === "RATE_LIMITED" || response.status === 429) {
        setKind("too_many_attempts");
        setMessage(portalCopy.tooManyAttempts);
        return;
      }
      if (json.error?.message?.includes("expired")) {
        setKind("expired_code");
        setMessage(portalCopy.expiredCode);
        return;
      }
      setKind("incorrect_code");
      setMessage(portalCopy.incorrectCode);
    } catch {
      setKind("network_failure");
      setMessage(portalCopy.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="portal">
      <h1>{portalCopy.appName}</h1>
      {kind === "loading" ? <p role="status">{portalCopy.loading}</p> : null}
      {kind === "invalid_link" || kind === "expired_quote" || kind === "superseded" || kind === "network_failure" ? (
        <p role="alert">{message}</p>
      ) : null}
      {meta && (kind === "awaiting_verification" || kind === "code_sent" || kind === "incorrect_code" || kind === "expired_code" || kind === "too_many_attempts" || kind === "resend_cooldown") ? (
        <>
          <p>{meta.business_name}</p>
          <p>{meta.document_type}</p>
          <p>Code will be sent to {meta.recipient_email_masked}</p>
        </>
      ) : null}
      {kind === "awaiting_verification" ? (
        <button type="button" onClick={() => void sendCode()} disabled={busy}>
          {busy ? portalCopy.sendingCode : portalCopy.requestCode}
        </button>
      ) : null}
      {kind === "code_sent" || kind === "incorrect_code" || kind === "expired_code" ? (
        <>
          {kind !== "code_sent" ? <p role="alert">{message}</p> : null}
          <label>
            {portalCopy.enterCode}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          </label>
          <button type="button" onClick={() => void verifyCode()} disabled={busy || code.length !== 6}>
            {busy ? portalCopy.verifying : portalCopy.verify}
          </button>
          <button type="button" onClick={() => void sendCode()} disabled={busy}>
            {portalCopy.resend}
          </button>
        </>
      ) : null}
      {kind === "too_many_attempts" || kind === "resend_cooldown" ? <p role="alert">{message}</p> : null}
    </main>
  );
}
