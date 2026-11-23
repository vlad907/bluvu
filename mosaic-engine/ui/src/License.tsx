import { useEffect, useRef, useState } from "react";
import { dialog, toast } from "./Dialogs";
import { api, type LicenseInfo } from "./api";

// Settings → License, and the pill in the top bar (docs/LICENSING_PLAN.md).
// Whatever the license says, the walls keep playing: this only shows the plan and what's locked,
// and installs license files.

const PLAN_NAMES: Record<string, string> = { starter: "Starter", venue: "Venue", enterprise: "Enterprise", comp: "Complimentary", trial: "Trial" };
const planName = (p: string) => PLAN_NAMES[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : "");
// License dates are whole UTC days: show them as such wherever the editor is opened.
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "");
// Every license view (this section, the top-bar pill) reloads on this.
const changed = () => window.dispatchEvent(new Event("mosaic-license"));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// One line for the state (the plan is shown beside it), and whether it needs attention.
export function licenseSummary(l: LicenseInfo): { text: string; level: "ok" | "warn" | "bad" } {
  switch (l.state) {
    case "valid":
      return { text: !l.expires ? "Doesn't expire" : l.renews ? `Renews on ${day(l.expires)}` : `Valid until ${day(l.expires)}`, level: "ok" };
    case "trial":
      return { text: `${plural(l.daysLeft, "day")} left`, level: l.daysLeft <= 3 ? "warn" : "ok" };
    case "expiring":
      if (l.renews) return { text: `Renews on ${day(l.expires)}`, level: "ok" };
      return { text: `Runs out in ${plural(l.daysLeft, "day")} (${day(l.expires)})`, level: "warn" };
    case "grace":
      return { text: `Ran out ${day(l.expires)} · ${plural(l.daysLeft, "day")} left to renew before editing pauses`, level: "warn" };
    case "expired":
      return { text: l.trial ? "The trial has ended" : `Ran out ${day(l.expires)}: editing and updates are paused`, level: "bad" };
    case "invalid":
      return { text: `Can't be used: ${l.reason}`, level: "bad" };
    default:
      return { text: "No license on this media server", level: "bad" };
  }
}

// The top-bar pill: only when something needs doing. In report-only mode (licensing not switched on
// yet) a missing license shows nothing, so a venue's editor looks as it did.
export function LicensePill({ info, onOpen }: { info: LicenseInfo | null; onOpen: () => void }) {
  if (!info) return null;
  const s = info.state;
  let text = "";
  if (s === "expiring" && info.renews) text = "";
  else if (s === "expiring") text = `License: ${plural(info.daysLeft, "day")} left`;
  else if (s === "grace") text = `License ran out: renew within ${plural(info.daysLeft, "day")}`;
  else if (s === "trial") text = `Trial: ${plural(info.daysLeft, "day")} left`;
  else if (s === "expired") text = info.trial ? "Trial ended" : "License ran out";
  else if ((s === "none" || s === "invalid") && info.enforced) text = s === "none" ? "No license" : "License problem";
  if (!text) return null;
  const bad = s === "expired" || s === "none" || s === "invalid";
  return (
    <button className={`engine-pill license-pill${bad ? " bad" : s === "trial" ? "" : " warn"}`} onClick={onOpen} title="Settings → License. The walls keep playing whatever the license says.">
      <span className={`dot ${bad ? "bad" : s === "trial" ? "on" : "warn"}`} />
      {text}
    </button>
  );
}

// Keeps the license info fresh (every minute, and right after the engine refused something for it).
export function useLicense(): [LicenseInfo | null, () => void] {
  const [info, setInfo] = useState<LicenseInfo | null>(null);
  const load = () => api.license().then(setInfo).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    window.addEventListener("mosaic-license", load);
    return () => (clearInterval(t), window.removeEventListener("mosaic-license", load));
  }, []);
  return [info, load];
}

export function LicenseSection({ onError }: { onError: (e: unknown) => void }) {
  const [info, reload] = useLicense();
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [paste, setPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const install = (text: string) =>
    api
      .installLicense(text)
      .then((l) => (toast(`License installed: ${planName(l.plan)} · ${licenseSummary(l).text}`), setPaste(null), setCode(""), changed()))
      .catch(onError);

  const makeCode = (forTrial = false) => {
    const k = forTrial ? "TRIAL" : key.trim();
    if (!k) return toast("Enter the license key first (it's in the email you got after buying)", "error");
    api.licenseRequestCode(k).then(setCode).catch(onError);
  };

  // Online calls go through the media server; they can take a few seconds.
  const online = (what: Promise<LicenseInfo>, done: (l: LicenseInfo) => string) => {
    setBusy(true);
    what
      .then((l) => (toast(done(l)), setKey(""), setCode(""), changed()))
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const activateOnline = () => {
    const k = key.trim();
    if (!k) return toast("Enter the license key first (it's in the email you got after buying)", "error");
    online(api.activateLicense(k), (l) => `Activated: ${planName(l.plan)} · ${licenseSummary(l).text}`);
  };
  const trial = async () => {
    const email = await dialog.prompt("Start a 14-day trial", {
      message: "All of Venue's features for 14 days, once per media server. We'll email you before it ends (optional).",
      placeholder: "you@venue.com",
      allowEmpty: true,
      okLabel: "Start trial",
    });
    if (email === null) return;
    online(api.startTrial(email), (l) => `Trial started: ${plural(l.daysLeft, "day")} left`);
  };

  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast("Copied"))
      .catch(() => toast("Couldn't copy: select the code and copy it by hand", "error"));

  const remove = async () => {
    const ok = await dialog.confirm("Remove the license from this media server?", {
      message: "Do this when moving the license to another PC: the license server is told (when it can be reached), so it doesn't count as a move. The walls keep playing, but changing the setup needs a license again.",
      okLabel: "Remove",
      danger: true,
    });
    if (ok) api.removeLicense().then(() => (toast("License removed"), changed())).catch(onError);
  };

  if (!info) {
    return (
      <section className="list" id="license">
        <div className="list-head">
          <h3>License</h3>
        </div>
        <small className="muted">Reading the license…</small>
      </section>
    );
  }

  const sum = licenseSummary(info);
  const verified = info.state !== "none" && info.state !== "invalid";
  const max = info.maxScreens;
  const used = info.used.screens;
  const needsRenewal = (info.state === "expiring" && !info.renews) || info.state === "grace" || info.state === "expired";
  const paidPlan = info.plan === "starter" || info.plan === "venue";

  return (
    <section className="list license" id="license">
      <div className="list-head">
        <h3 title="One license per media server, per year. Receiving PCs never need one.">License</h3>
        <button onClick={reload}>Refresh</button>
      </div>

      {/* Not alarming while licensing isn't switched on: nothing is locked. */}
      <div className={`license-state ${!info.enforced && !verified ? "" : sum.level}`}>
        <span className={`dot ${!info.enforced && !verified ? "off" : sum.level === "ok" ? "on" : sum.level}`} />
        <div className="list-text">
          <div>{verified ? `${planName(info.plan)}${info.customer ? ` · ${info.customer}` : ""}` : "Not licensed"}</div>
          <small title={sum.text}>{sum.text}</small>
        </div>
      </div>

      <div className="license-usage">
        <div className="usage-line">
          <span>Screens</span>
          <b>{max < 0 ? `${used} · unlimited` : verified ? `${used} of ${max}` : used}</b>
        </div>
        {verified && max > 0 && <progress className={`usage-bar${used > max ? " over" : ""}`} value={Math.min(used, max)} max={max} />}
        {verified && max >= 0 && used > max && <small className="warn">Over the plan: everything keeps running, but screens can't be added.</small>}
        <small className="muted">
          {plural(info.used.canvases, "wall")} · {plural(info.used.audioOutputs, "sound output")} · {plural(info.used.captureSources, "capture card")}
          {verified && !info.features.includes("multiCanvas") && " · Venue adds several walls, sound zones and capture cards"}
        </small>
      </div>

      <small className="muted">
        The walls always keep showing what they show, and come back after a restart. When a license runs out (30 days after its end date), changing the setup and
        updates pause until it's renewed; presets, scenes and the control API keep working.
      </small>

      {!info.enforced && (
        <small className="muted license-note">
          Licensing isn't switched on for this server yet: nothing is locked.
          {info.wouldBlock.count > 0 && ` ${plural(info.wouldBlock.count, "change")} would have needed a license.`}
        </small>
      )}

      <div className="row-buttons">
        {needsRenewal && (
          <a className="button primary" href={info.links.renew} target="_blank" rel="noreferrer">
            Renew
          </a>
        )}
        {(!verified || (info.plan !== "enterprise" && info.plan !== "comp")) && (
          <a className="button" href={verified && info.plan === "starter" ? info.links.billing : info.links.buy} target="_blank" rel="noreferrer">
            {verified ? "Upgrade" : "Buy a license"}
          </a>
        )}
        {verified && paidPlan && (
          <a className="button ghost" href={info.links.billing} target="_blank" rel="noreferrer" title="Card, receipts, upgrading or cancelling: a link is emailed to the billing contact">
            Billing
          </a>
        )}
      </div>

      <h4 className="license-sub">{verified ? "Replace or renew" : "Activate"}</h4>
      <input className="license-key" placeholder="License key, BLUVU-XXXXX-…" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
      <div className="row-buttons">
        {info.online && (
          <button className="primary" disabled={busy} onClick={activateOnline} title="The media server asks the license server (it needs internet)">
            {busy ? "Working…" : "Activate online"}
          </button>
        )}
        <button onClick={() => makeCode()} title="For a media server without internet: make a code to paste on the website from any device">
          Get request code
        </button>
      </div>
      {!verified && info.online && (
        <div className="row-buttons">
          <button disabled={busy} onClick={trial} title="All of Venue's features for 14 days, once per media server">
            Start a 14-day trial
          </button>
          <button className="ghost" onClick={() => makeCode(true)} title="A trial for a media server without internet: paste the code on the website">
            Trial offline
          </button>
        </div>
      )}
      {code && (
        <div className="license-code">
          <small className="muted">
            On any device with internet, open <a href={info.links.activate} target="_blank" rel="noreferrer">{info.links.activate.replace(/^https?:\/\//, "")}</a>, paste this
            code, and bring back the license file it gives you.
          </small>
          <textarea readOnly value={code} rows={3} onFocus={(e) => e.target.select()} />
          <button onClick={() => copy(code)}>Copy code</button>
        </div>
      )}

      <div className="row-buttons">
        <button onClick={() => fileInput.current?.click()} title="A .json license file from the website or from Blue Arc Networks">
          Install license file…
        </button>
        <button className="ghost" onClick={() => setPaste(paste === null ? "" : null)}>
          {paste === null ? "Paste instead" : "Cancel"}
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json,.txt,.lic"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) f.text().then(install);
        }}
      />
      {paste !== null && (
        <>
          <textarea className="license-paste" rows={5} placeholder='{"payload": "…", "sig": "…"}' value={paste} onChange={(e) => setPaste(e.target.value)} spellCheck={false} />
          <button className="primary" disabled={!paste.trim()} onClick={() => install(paste)}>
            Install
          </button>
        </>
      )}

      <small className="muted license-machine" title="Hashes of this PC's identifiers: what the license is bound to (2 of 3 must match)">
        This media server: {[info.machine.machineGuid, info.machine.smbiosUuid, info.machine.systemDisk].map((h) => (h ? h.slice(0, 6) : "–")).join(" · ")}
        {info.licenseId && ` · license ${info.licenseId}`}
        {info.testBuild && " · test build"}
      </small>
      {verified && info.online && (
        <small className="muted">
          {info.lastRefresh
            ? `Checked with the license server ${new Date(info.lastRefresh.time).toLocaleString()}: ${info.lastRefresh.ok ? "up to date" : info.lastRefresh.message}`
            : "Checks with the license server once a day when it can (renewals arrive by themselves); without internet it keeps working until the license's end date."}{" "}
          <button className="text-link" disabled={busy} onClick={() => online(api.refreshLicense(), () => "License up to date")}>
            Check now
          </button>
        </small>
      )}
      {verified && (
        <button className="ghost danger-text" onClick={remove} title="To move the license to another media server">
          Remove from this server
        </button>
      )}
    </section>
  );
}
