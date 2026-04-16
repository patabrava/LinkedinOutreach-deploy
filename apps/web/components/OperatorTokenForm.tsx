"use client";

import { FormEvent, useEffect, useState } from "react";

import { clearOperatorApiToken, getOperatorApiToken, setOperatorApiToken } from "../lib/operatorToken";

export function OperatorTokenForm() {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setToken(getOperatorApiToken());
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOperatorApiToken(token);
    setSaved(true);
  };

  const onClear = () => {
    clearOperatorApiToken();
    setToken("");
    setSaved(false);
  };

  return (
    <form onSubmit={onSubmit} className="card" style={{ marginBottom: 16 }}>
      <div className="pill">Operator API</div>
      <h3 style={{ margin: "12px 0 8px 0" }}>REMOTE CONTROL TOKEN</h3>
      <div className="muted" style={{ marginBottom: 16 }}>
        Set the temporary operator token here. It must match `API_OPERATOR_TOKEN` on the VPS so browser actions can reach the control-plane routes.
      </div>

      <label htmlFor="operator-token">Operator token</label>
      <input
        id="operator-token"
        className="input"
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => {
          setToken(event.target.value);
          setSaved(false);
        }}
        placeholder="Paste the operator token"
      />

      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <button className="btn" type="submit">
          Save token
        </button>
        <button className="btn secondary" type="button" onClick={onClear}>
          Clear token
        </button>
      </div>

      {saved ? (
        <div className="pill status-approved" style={{ marginTop: 12 }}>
          Token saved locally for this browser.
        </div>
      ) : null}
    </form>
  );
}

