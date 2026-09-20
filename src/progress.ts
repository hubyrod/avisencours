// Progression d'une mise à jour : jalons (une étape par source, puis le
// classement, puis l'email) avec compteur dans l'étape en cours. Le job
// (run.ts) alimente un ProgressTracker via le pipeline et écrit l'état dans
// runs.progress ; les pages (server.ts) le lisent avec la ligne du run.
// Logique pure, sans accès base ni horloge cachée (injection de `now`).

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type StepUnit = "pages" | "avis" | "mots-clés";

export type ProgressStep = {
  id: string;
  label: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  done?: number;
  total?: number | null;
  unit?: StepUnit;
  detail?: string;
};

export type RunProgress = {
  steps: ProgressStep[];
  updatedAt: string;
};

export type StepDef = { id: string; label: string; unit?: StepUnit };

export type TrackerOptions = {
  onChange?: (p: RunProgress) => void;
  // Délai minimal entre deux notifications sans changement d'état (les
  // compteurs) : évite d'écrire en base à chaque avis classé.
  throttleMs?: number;
  now?: () => Date;
};

export class ProgressTracker {
  private readonly steps: ProgressStep[];
  private readonly onChange?: (p: RunProgress) => void;
  private readonly throttleMs: number;
  private readonly now: () => Date;
  private lastNotify = 0;

  constructor(defs: StepDef[], opts: TrackerOptions = {}) {
    this.steps = defs.map((d) => ({ id: d.id, label: d.label, status: "pending", ...(d.unit ? { unit: d.unit } : {}) }));
    this.onChange = opts.onChange;
    this.throttleMs = opts.throttleMs ?? 2000;
    this.now = opts.now ?? (() => new Date());
  }

  snapshot(): RunProgress {
    return { steps: this.steps.map((s) => ({ ...s })), updatedAt: this.now().toISOString() };
  }

  private step(id: string): ProgressStep {
    const s = this.steps.find((x) => x.id === id);
    if (!s) throw new Error(`étape de progression inconnue : ${id}`);
    return s;
  }

  start(id: string, total?: number | null): void {
    const s = this.step(id);
    s.status = "running";
    s.startedAt = this.now().toISOString();
    s.done = 0;
    if (total !== undefined) s.total = total;
    this.notify(true);
  }

  advance(id: string, done: number, total?: number | null): void {
    const s = this.step(id);
    if (s.status === "pending") this.start(id, total);
    s.done = done;
    if (total !== undefined) s.total = total;
    this.notify(false);
  }

  finish(id: string, detail?: string): void {
    this.end(id, "done", detail);
  }

  fail(id: string, detail: string): void {
    this.end(id, "failed", detail);
  }

  skip(id: string, detail?: string): void {
    const s = this.step(id);
    s.status = "skipped";
    if (detail) s.detail = detail;
    this.notify(true);
  }

  private end(id: string, status: "done" | "failed", detail?: string): void {
    const s = this.step(id);
    if (s.status === "pending") s.startedAt = this.now().toISOString();
    s.status = status;
    s.finishedAt = this.now().toISOString();
    if (detail) s.detail = detail;
    // Une étape terminée sans total connu est complète.
    if (status === "done" && s.done !== undefined && (s.total === undefined || s.total === null)) s.total = s.done;
    this.notify(true);
  }

  private notify(force: boolean): void {
    if (!this.onChange) return;
    const t = this.now().getTime();
    if (!force && t - this.lastNotify < this.throttleMs) return;
    this.lastNotify = t;
    this.onChange(this.snapshot());
  }
}

// Part accomplie, 0–1 : étapes terminées (ou sautées/échouées) comptent 1,
// l'étape en cours sa fraction si le total est connu.
export function progressPercent(p: RunProgress): number {
  const counted = p.steps.filter((s) => s.status !== "skipped");
  if (counted.length === 0) return 0;
  let sum = 0;
  for (const s of counted) {
    if (s.status === "done" || s.status === "failed") sum += 1;
    else if (s.status === "running" && s.total && s.done !== undefined) sum += Math.min(1, s.done / s.total);
  }
  return Math.min(1, sum / counted.length);
}

// Forme courte, sans accents ni espaces insécables : « 1 240 / 3 900 avis ».
export function formatCounter(s: ProgressStep): string {
  if (s.done === undefined) return "";
  const n = (x: number) => x.toLocaleString("fr-FR").replace(/[\u202f\u00a0]/g, " ");
  const unit = s.unit ?? "";
  return s.total ? `${n(s.done)} / ${n(s.total)} ${unit}`.trim() : `${n(s.done)} ${unit}`.trim();
}

// « 12 min », « 1 h 05 », « 45 s ».
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")}`;
}

// Une ligne pour le bandeau du tableau de bord (les sources sont lues en
// parallèle : plusieurs étapes peuvent être en cours) :
// « BOAMP terminé · Maximilien 8 / 22 pages · Marchés Online 3 / 47 mots-clés · démarrée il y a 12 min »
export function summarizeProgress(p: RunProgress, startedAt: Date, now: Date = new Date()): string {
  const parts: string[] = [];
  const done = p.steps.filter((s) => s.status === "done").map((s) => s.label);
  const failed = p.steps.filter((s) => s.status === "failed").map((s) => s.label);
  if (done.length) parts.push(`${done.join(", ")} terminé${done.length > 1 ? "s" : ""}`);
  if (failed.length) parts.push(`${failed.join(", ")} en échec`);
  for (const running of p.steps.filter((s) => s.status === "running")) {
    const counter = formatCounter(running);
    parts.push(counter ? `${running.label} ${counter}` : `${running.label} en cours`);
  }
  parts.push(`démarrée il y a ${formatDuration(now.getTime() - startedAt.getTime())}`);
  return parts.join(" · ");
}

// Valeur lue en base (jsonb, éventuellement chaîne) -> RunProgress ou null.
export function normalizeProgress(v: unknown): RunProgress | null {
  let s: unknown = v;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!s || typeof s !== "object") return null;
  const o = s as Partial<RunProgress>;
  if (!Array.isArray(o.steps)) return null;
  const steps = o.steps.filter(
    (x): x is ProgressStep => !!x && typeof x === "object" && typeof x.id === "string" && typeof x.status === "string",
  );
  return { steps, updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "" };
}
