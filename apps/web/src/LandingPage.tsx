import { useEffect, useRef, useState, type RefObject } from "react";
import type { AuthMode } from "./AuthDialog.js";

const pipeline = [
  {
    id: "connect",
    icon: "↔",
    label: "Connect",
    title: "Verify any DHIS2 endpoint",
    copy: "Normalise the base URL, prove the credential against /api/me, read the version from /api/system/info, and infer a per-API capability map.",
    facts: ["AES-256-GCM credential vault", "Basic auth or personal access token", "detected · inferred · unknown confidence"]
  },
  {
    id: "snapshot",
    icon: "◉",
    label: "Snapshot",
    title: "Pin metadata by content hash",
    copy: "Every Program or Data Set is stored as an immutable snapshot keyed by its hash, so a blueprint always points at exactly the metadata it came from.",
    facts: ["Immutable metadata_snapshots", "Deduplicated by content hash", "Fully reproducible builds"]
  },
  {
    id: "schema",
    icon: "▦",
    label: "Model",
    title: "Generate relational schemas",
    copy: "DHIS2 value types map deterministically to SQL types, collisions get safe column names, and option-set columns gain a readable *_name twin.",
    facts: ["Deterministic, rules-based output", "Additive ALTER TABLE reconciliation", "Re-apply to evolve, never to recreate"]
  },
  {
    id: "sync",
    icon: "◴",
    label: "Synchronise",
    title: "Pull, flatten and swap atomically",
    copy: "Runs land in a per-run staging table, then a single locked transaction truncates and swaps it in. Oversized requests halve their date range, then split the org-unit list.",
    facts: ["Full-replace runs, never half-written", "Automatic request splitting on timeout", "Adaptive tracker page sizing"]
  },
  {
    id: "report",
    icon: "≡",
    label: "Report",
    title: "Single-line reports and backups",
    copy: "Read the generated tables directly, filter and paginate them, and export CSV or JSON with the untouched DHIS2 payload kept alongside every row.",
    facts: ["One line per tracked entity", "CSV and JSON export", "raw_payload retained for audit"]
  }
] as const;

const features = [
  { icon: "⛨", title: "Secrets never leave the vault", copy: "Credentials are encrypted into three columns and no endpoint can echo them back — responses only ever carry a connection summary." },
  { icon: "⌗", title: "Two planes, cleanly separated", copy: "A parameterised control plane governs configuration; generated reporting tables live apart in their own schema behind a strict identifier guard." },
  { icon: "⇄", title: "Version-aware by design", copy: "The client adapts to what a server actually supports, from legacy tracker endpoints through to the modern tracker API." },
  { icon: "◷", title: "Scheduling that will not double-run", copy: "Interval schedules are polled continuously and guarded against overlap, so a long run never trips over the next one." },
  { icon: "↧", title: "Backups you can actually read", copy: "Export any applied table on demand as CSV or JSON — no proprietary envelope, no lock-in." },
  { icon: "✓", title: "Typed end to end", copy: "One package of zod schemas is the single source of truth for the API surface, shared by the server and the dashboard alike." }
] as const;

const metrics = [
  { value: 6, suffix: "", label: "Pipeline stages", detail: "connect through to export" },
  { value: 100, suffix: "%", label: "Typed contracts", detail: "zod-validated API surface" },
  { value: 256, suffix: "-bit", label: "Credential encryption", detail: "AES-GCM at rest" },
  { value: 5, suffix: "s", label: "Schedule poll", detail: "interval jobs stay prompt" }
] as const;

function useCountUp(target: number, active: boolean): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setValue(target); return; }
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - started) / 1100, 1);
      setValue(Math.round(target * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, active]);
  return value;
}

function Metric({ value, suffix, label, detail, active }: { value: number; suffix: string; label: string; detail: string; active: boolean }) {
  const shown = useCountUp(value, active);
  return <li><strong>{shown}{suffix}</strong><span>{label}</span><small>{detail}</small></li>;
}

function useInView(): [RefObject<HTMLElement | null>, boolean] {
  const ref = useRef<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setSeen(true); observer.disconnect(); }
    }, { threshold: 0.25 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

export function LandingPage({ onAuth }: { onAuth: (mode: AuthMode) => void }) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [metricsRef, metricsVisible] = useInView();
  const step = pipeline[active] ?? pipeline[0];

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setActive((current) => (current + 1) % pipeline.length), 4200);
    return () => window.clearInterval(timer);
  }, [paused]);

  const choose = (index: number) => { setActive(index); setPaused(true); };

  return <div className="landing">
    <div className="landing-aurora" aria-hidden="true"><span /><span /><span /></div>
    <header className="landing-nav">
      <div className="brand"><span className="brand-mark">D2</span><div><strong>Interoperability</strong><small>DHIS2 data hub</small></div></div>
      <div className="landing-nav-actions">
        <button type="button" className="button button--ghost" onClick={() => onAuth("signin")}>Sign in</button>
        <button type="button" className="button button--primary" onClick={() => onAuth("signup")}>Sign up</button>
      </div>
    </header>

    <main id="main-content">
      <section className="hero">
        <div className="hero-copy">
          <p className="hero-badge"><span className="environment-dot" />Control plane · API v1 · PostgreSQL</p>
          <h1>Turn DHIS2 metadata into <em>reporting tables you own</em>.</h1>
          <p className="lede">Connect any DHIS2 instance, generate a relational schema straight from its metadata, keep it synchronised on a schedule, and read single-line reports out of your own database.</p>
          <div className="hero-actions">
            <button type="button" className="button button--primary button--lg" onClick={() => onAuth("signup")}>Create your workspace</button>
            <button type="button" className="button button--quiet button--lg" onClick={() => onAuth("signin")}>Sign in to continue</button>
          </div>
          <ul className="hero-ticks">
            <li>No DHIS2 write access required</li>
            <li>Credentials encrypted at rest</li>
            <li>CSV and JSON export</li>
          </ul>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="flow-card">
            <div className="flow-card-bar"><span /><span /><span /></div>
            <div className="flow-rows">
              {pipeline.map((item, index) => <div className={`flow-row ${index === active ? "lit" : ""}`} key={item.id}>
                <span className="flow-icon">{item.icon}</span>
                <span className="flow-name">{item.label}</span>
                <span className="flow-track"><i style={{ animationDelay: `${index * 180}ms` }} /></span>
                <span className="flow-state">{index === active ? "running" : index < active ? "done" : "queued"}</span>
              </div>)}
            </div>
            <div className="flow-foot"><code>dhis_data.tracked_entities</code><span>full replace · staged swap</span></div>
          </div>
          <div className="floating-chip floating-chip--a">+ 14 columns reconciled</div>
          <div className="floating-chip floating-chip--b">snapshot 9f3c…a1 pinned</div>
        </div>
      </section>

      <section className="landing-metrics" ref={metricsRef}>
        <ul>{metrics.map((metric) => <Metric key={metric.label} {...metric} active={metricsVisible} />)}</ul>
      </section>

      <section className="landing-section">
        <div className="section-head">
          <p className="eyebrow">How it works</p>
          <h2>Five stages, one deterministic pipeline</h2>
          <p className="lede">Pick a stage to see what the platform does at that point. It advances on its own until you take over.</p>
        </div>
        <div className="stepper">
          <div className="stepper-rail" role="tablist" aria-label="Pipeline stages">
            {pipeline.map((item, index) => <button
              type="button"
              role="tab"
              aria-selected={index === active}
              className={`stepper-tab ${index === active ? "active" : ""}`}
              key={item.id}
              onClick={() => choose(index)}
            >
              <span className="stepper-icon" aria-hidden="true">{item.icon}</span>
              <span className="stepper-label"><small>Stage {index + 1}</small><strong>{item.label}</strong></span>
            </button>)}
          </div>
          <div className="stepper-detail" key={step.id}>
            <p className="step">Stage {active + 1} of {pipeline.length}</p>
            <h3>{step.title}</h3>
            <p>{step.copy}</p>
            <ul>{step.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
            {paused && <button type="button" className="text-button" onClick={() => setPaused(false)}>Resume the tour →</button>}
          </div>
        </div>
      </section>

      <section className="landing-section">
        <div className="section-head">
          <p className="eyebrow">Built for health data teams</p>
          <h2>Boring where it counts, fast everywhere else</h2>
        </div>
        <div className="feature-grid">
          {features.map((feature) => <article key={feature.title}>
            <span aria-hidden="true">{feature.icon}</span>
            <h3>{feature.title}</h3>
            <p>{feature.copy}</p>
          </article>)}
        </div>
      </section>

      <section className="landing-cta">
        <div>
          <p className="eyebrow">Ready when you are</p>
          <h2>Your first table is four clicks away</h2>
          <p>Create an account, point it at a DHIS2 server, and generate a schema from real metadata in minutes.</p>
        </div>
        <div className="landing-cta-actions">
          <button type="button" className="button button--primary button--lg" onClick={() => onAuth("signup")}>Sign up free</button>
          <button type="button" className="button button--ghost button--lg" onClick={() => onAuth("signin")}>Sign in</button>
        </div>
      </section>
    </main>

    <footer className="landing-foot">
      <span>DHIS2 Interoperability Hub</span>
      <small>Development environment · API v1 · PostgreSQL</small>
    </footer>
  </div>;
}
