import { runPipeline } from "./pipeline.ts";
import {
  migrate,
  tryAcquireRunLock,
  startRun,
  finishRun,
  upsertAnnouncements,
  getNewSinceLastDigest,
  getUpcomingDeadlines,
  markDigestSent,
  listKeywords,
  listScopeRules,
  getSetting,
} from "./db.ts";
import { buildQueryFromKeywords, validateDigestWindow, parseDepartements } from "./rules.ts";
import {
  sendEmail,
  hasEmailToken,
  uniqueEmails,
  renderDigestHtml,
  renderAlertHtml,
  digestSubject,
} from "./email.ts";
import { cleanupAuth, getDigestUserEmails } from "./auth.ts";

function frDate(d: Date): string {
  return d.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
}

async function sendAlert(error: string): Promise<void> {
  const to = Bun.env.ALERT_RECIPIENT;
  if (!to || !hasEmailToken()) {
    console.error("no ALERT_RECIPIENT/MAILPACE_API_TOKEN — skipping alert email");
    return;
  }
  try {
    await sendEmail({
      to: [to],
      subject: "⚠️ Avis en cours — échec de la mise à jour quotidienne",
      html: renderAlertHtml(error, frDate(new Date())),
    });
  } catch (e) {
    console.error(`alert email failed too: ${e}`);
  }
}

async function main() {
  await migrate();

  if (!(await tryAcquireRunLock())) {
    console.error("another run is already in progress — skipping");
    return;
  }

  const runId = await startRun();
  console.error(`run #${runId} started`);

  try {
    // Configuration éditable (/configuration) — lue ici, dans le try, pour
    // qu'un échec de lecture passe par le circuit erreur + email d'alerte.
    const [keywords, ruleRows, windowSetting, classifierSetting, depSetting] = await Promise.all([
      listKeywords(),
      listScopeRules(),
      getSetting("digest_window_days"),
      getSetting("classifier_mode"),
      getSetting("code_departements"),
    ]);
    const scopeRules = {
      keep: ruleRows.filter((r) => r.kind === "keep").map((r) => r.term),
      exclude: ruleRows.filter((r) => r.kind === "exclude").map((r) => r.term),
    };
    const dep = parseDepartements(depSetting ?? "");
    const digestWindow =
      windowSetting && validateDigestWindow(windowSetting).ok ? Number(windowSetting) : 14;

    const { relevant, travaux, excluded } = await runPipeline({
      maxPages: Bun.env.MAX_PAGES ? Number(Bun.env.MAX_PAGES) : undefined,
      // Table vide = repli sur la liste par défaut (defaults.ts).
      query: keywords.length > 0 ? buildQueryFromKeywords(keywords.map((k) => k.term)) : undefined,
      // Un réglage en base l'emporte sur la variable d'environnement.
      classifier: classifierSetting ?? Bun.env.CLASSIFIER,
      scopeRules,
      codeDepartement: dep.ok ? dep.codes : [],
    });

    const all = [...relevant, ...travaux, ...excluded];
    await upsertAnnouncements(runId, all);
    await finishRun(runId, {
      status: "success",
      totalFetched: all.length,
      relevant: relevant.length,
      travaux: travaux.length,
      excluded: excluded.length,
    });
    console.error(
      `run #${runId} done — relevant: ${relevant.length}, travaux: ${travaux.length}, excluded: ${excluded.length}`,
    );

    await cleanupAuth();

    // Run manuel (« Relancer maintenant ») : pas de digest. Les nouveautés
    // resteront « nouvelles » pour le prochain digest réellement envoyé.
    if (Bun.env.SKIP_DIGEST === "1") {
      console.error("SKIP_DIGEST=1 — skipping digest email (manual run)");
      return;
    }

    // Recipients = users who opted in on /profil.
    const recipients = uniqueEmails([await getDigestUserEmails()]);
    if (recipients.length === 0 || !hasEmailToken()) {
      console.error("no opted-in digest recipients or no MAILPACE_API_TOKEN — skipping digest email");
      return;
    }

    const newRelevant = await getNewSinceLastDigest(runId, "relevant");
    const upcoming = await getUpcomingDeadlines(runId, digestWindow);
    const data = {
      newRelevant,
      upcoming,
      totalRelevant: relevant.length,
      totalTravaux: travaux.length,
      dashboardUrl: Bun.env.DASHBOARD_URL ?? null,
      dateStr: frDate(new Date()),
    };
    await sendEmail({
      to: recipients,
      subject: digestSubject(data),
      html: renderDigestHtml(data),
    });
    await markDigestSent(runId);
    console.error(`digest sent to ${recipients.length} recipient(s)`);
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`run #${runId} failed: ${msg}`);
    try {
      await finishRun(runId, { status: "error", error: msg });
    } catch (e) {
      console.error(`could not record failure: ${e}`);
    }
    await sendAlert(msg);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Bun.sql keeps the process alive; exit explicitly once done.
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });
