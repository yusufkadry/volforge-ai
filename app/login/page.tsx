"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, LockKeyhole, Sparkles } from "lucide-react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.ok) window.location.assign("/");
    else {
      setError("That access code does not match.");
      setPending(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-label="VolForge access">
        <div className="brand-mark"><Sparkles size={22} /></div>
        <p className="eyebrow">VOLFORGE / PAPER CONTROL ROOM</p>
        <h1>Trade the shape<br />of volatility.</h1>
        <p className="login-copy">Private command surface for the VolForge options intelligence agent.</p>
        <form onSubmit={submit}>
          <label htmlFor="password">Access code</label>
          <div className="password-input">
            <LockKeyhole size={17} />
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? "Authenticating" : "Enter command room"} <ArrowRight size={17} />
          </button>
        </form>
      </section>
      <div className="login-grid" aria-hidden="true">
        <div className="surface-line one" /><div className="surface-line two" /><div className="surface-line three" />
        <div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" />
      </div>
    </main>
  );
}
