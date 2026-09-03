// POST avec nouvelles tentatives, partagé par llm.ts (OpenRouter) et email.ts
// (MailPace). Réessaie les statuts listés ET les erreurs réseau / délai
// dépassé (AbortSignal.timeout rejette avec un TimeoutError, pas un statut).
// Un signal externe (coupe-circuit) abandonne immédiatement, sans réessai.

export const DEFAULT_RETRYABLE: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type RetryOptions = {
  retryable?: ReadonlySet<number>;
  attempts?: number;
  timeoutMs?: number;
  // Plafond de tentatives propre à un statut (ex. 503 OpenRouter = « aucun
  // fournisseur ne répond aux critères », le plus souvent déterministe).
  attemptsFor?: (status: number) => number | undefined;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(label: string, status: number, body: string) {
    super(`${label} ${status}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.random() * 400;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

// Le corps est lu ici, dans la boucle : le délai (AbortSignal.timeout) couvre
// aussi le flux de réponse, et une coupure pendant sa lecture est réessayée
// comme une erreur réseau.
export async function postWithRetry(
  label: string,
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<{ res: Response; text: string; retries: number }> {
  const retryable = opts.retryable ?? DEFAULT_RETRYABLE;
  const maxAttempts = opts.attempts ?? 4;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(url, { ...init, method: "POST", signal: combineSignals(timeoutMs, opts.signal) });
      text = await res.text();
    } catch (err) {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error(`${label} unreachable after ${attempt} attempt(s): ${errMessage(err)}`);
    }
    if (res.ok) return { res, text, retries: attempt - 1 };

    const cap = Math.min(maxAttempts, opts.attemptsFor?.(res.status) ?? maxAttempts);
    if (retryable.has(res.status) && attempt < cap) {
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new HttpError(label, res.status, text);
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const e = new Error(typeof reason === "string" ? reason : "aborted");
  e.name = "AbortError";
  return e;
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
