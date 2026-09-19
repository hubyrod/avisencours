import { runPipeline } from "./pipeline.ts";
import {
  migrate,
  tryAcquireRunLock,
  startRun,
  finishRun,
  upsertAnnouncements,
  regrouperDoublons,
  countByCategory,
  attachPublications,
  getNewSinceLastDigest,
  getUpcomingDeadlines,
  markDigestSent,
  updateRunProgress,
  listKeywords,
  listScopeRules,
  getSetting,
  getLastRun,
  heartbeatStale,
  terminateRunLockHolders,
} from "./db.ts";
import {
  buildQueryFromKeywords,
  validateDigestWindow,
  parseDepartements,
  parseModelChain,
  validateModelChain,
} from "./rules.ts";
import {
  sendEmail,
  hasEmailToken,
  uniqueEmails,
  renderDigestHtml,
  renderAlertHtml,
  renderWarningHtml,
  digestSubject,
} from "./email.ts";
import { cleanupAuth, getDigestUserEmails } from "./auth.ts";
import type { LlmStats } from "./llm.ts";
import { SOURCES } from "./sources.ts";
import { ProgressTracker } from "./progress.ts";

function frDate(d: Date): string {
  return d.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
}

async function sendAlert(subject: string, html: string): Promise<void> {
  const to = Bun.env.ALERT_RECIPIENT;
  if (!to || !hasEmailToken()) {
    console.error("no ALERT_RECIPIENT/MAILPACE_API_TOKEN — skipping alert email");
    return;
  }
  try {
    await sendEmail({ to: [to], subject, html });
  } catch (e) {
    console.error(`alert email failed too: ${e}`);
  }
}

// Réglage « llm_models » en base : validé à la saisie (/configuration), mais
// on revalide par prudence — une valeur cassée retombe sur env/défaut.
function chainFromSetting(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const v = validateModelChain(value);
  if (!v.ok) {
    console.error(`llm_models setting ignored — ${v.error}`);
    return undefined;
  }
  return parseModelChain(v.value);
}

async function main() {
  await migrate();

  if (!(await tryAcquireRunLock())) {
    // Verrou tenu par une session zombie (processus tué, cf. db.ts) ? On la
    // termine et on réessaie une fois ; sinon un run tourne vraiment.
    const last = await getLastRun();
    if (last?.status === "running" && heartbeatStale(last)) {
      const n = await terminateRunLockHolders();
      console.error(`run #${last.id}: verrou tenu sans battement — ${n} session(s) zombie terminée(s)`);
    }
    if (!(await tryAcquireRunLock())) {
      console.error("another run is already in progress — skipping");
      return;
    }
  }

  const runId = await startRun();
  console.error(`run #${runId} started`);

  // Jalons : une étape par source (même désactivée : elle apparaît « sautée »),
  // puis le classement, puis l'email. Chaque changement d'état est écrit dans
  // runs.progress (compteurs limités à un écrit toutes les 2 s) ; une erreur
  // d'écriture ne doit jamais interrompre le run.
  const progress = new ProgressTracker(
    [
      ...SOURCES.map((s) => ({ id: s.id, label: s.label, unit: s.id === "marchesonline" ? ("mots-clés" as const) : ("pages" as const) })),
      { id: "classify", label: "Classement", unit: "avis" as const },
      { id: "digest", label: "Email quotidien" },
    ],
    {
      onChange: (p) => {
        updateRunProgress(runId, p).catch((e) => console.error(`progress write failed: ${e}`));
      },
    },
  );

  try {
    // Configuration éditable (/configuration) — lue ici, dans le try, pour
    // qu'un échec de lecture passe par le circuit erreur + email d'alerte.
    const [keywords, ruleRows, windowSetting, classifierSetting, depSetting, modelsSetting] =
      await Promise.all([
        listKeywords(),
        listScopeRules(),
        getSetting("digest_window_days"),
        getSetting("classifier_mode"),
        getSetting("code_departements"),
        getSetting("llm_models"),
      ]);
    const scopeRules = {
      keep: ruleRows.filter((r) => r.kind === "keep").map((r) => r.term),
      exclude: ruleRows.filter((r) => r.kind === "exclude").map((r) => r.term),
    };
    const dep = parseDepartements(depSetting ?? "");
    const digestWindow =
      windowSetting && validateDigestWindow(windowSetting).ok ? Number(windowSetting) : 14;

    const { relevant, travaux, excluded, llm, warning } = await runPipeline({
      maxPages: Bun.env.MAX_PAGES ? Number(Bun.env.MAX_PAGES) : undefined,
      // Table vide = repli sur la liste par défaut (defaults.ts).
      query: keywords.length > 0 ? buildQueryFromKeywords(keywords.map((k) => k.term)) : undefined,
      // Un réglage en base l'emporte sur la variable d'environnement.
      classifier: classifierSetting ?? Bun.env.CLASSIFIER,
      llmModels: chainFromSetting(modelsSetting),
      scopeRules,
      codeDepartement: dep.ok ? dep.codes : [],
      progress,
    });

    const all = [...relevant, ...travaux, ...excluded];
    await upsertAnnouncements(runId, all);
    // Même appel d'offres sur plusieurs plateformes : une seule ligne comptée.
    const dbl = await regrouperDoublons(runId);
    console.error(`doublons: ${dbl.groupes} groupe(s), ${dbl.doublons} publication(s) rattachée(s)`);
    const comptes = await countByCategory(runId);
    const nRelevant = comptes.relevant ?? 0;
    const nTravaux = comptes.travaux ?? 0;
    const nExcluded = comptes.excluded ?? 0;
    // Le dernier compteur a pu être retenu par la limitation : état final exact.
    await updateRunProgress(runId, progress.snapshot()).catch((e) => console.error(`progress write failed: ${e}`));
    await finishRun(runId, {
      status: "success",
      totalFetched: all.length,
      relevant: nRelevant,
      travaux: nTravaux,
      excluded: nExcluded,
      llmStats: llm ?? null,
      warning: warning ?? null,
    });
    console.error(
      `run #${runId} done — relevant: ${nRelevant}, travaux: ${nTravaux}, excluded: ${nExcluded} (appels d'offres ; ${all.length} publications)`,
    );

    await cleanupAuth();

    // Avertissement non bloquant (coupe-circuit, clé absente) : email d'alerte
    // même si le run est un succès — sinon la dégradation passe inaperçue.
    if (warning) {
      const subject = /LLM|OPENROUTER|coupe-circuit/i.test(warning)
        ? "⚠️ Avis en cours — classification LLM interrompue"
        : "⚠️ Avis en cours — mise à jour partielle";
      await sendAlert(subject, renderWarningHtml(warning, llm, frDate(new Date())));
    }

    // Run manuel (« Relancer maintenant ») : pas de digest. Les nouveautés
    // resteront « nouvelles » pour le prochain digest réellement envoyé.
    if (Bun.env.SKIP_DIGEST === "1") {
      console.error("SKIP_DIGEST=1 — skipping digest email (manual run)");
      progress.skip("digest", "mise à jour manuelle");
      return;
    }

    // Coupe-circuit ouvert : une partie des avis n'a été classée que par regex.
    // On n'envoie pas le digest et on ne marque pas digest_sent, pour que le
    // prochain run sain annonce ces avis correctement classés. L'alerte
    // ci-dessus tient lieu de signe de vie pour la journée.
    if (llm?.breakerTripped) {
      console.error("LLM breaker tripped — skipping digest email (will be sent by the next healthy run)");
      progress.skip("digest", "coupe-circuit LLM : reporté au prochain run sain");
      return;
    }

    // Recipients = users who opted in on /profil.
    const recipients = uniqueEmails([await getDigestUserEmails()]);
    if (recipients.length === 0 || !hasEmailToken()) {
      console.error("no opted-in digest recipients or no MAILPACE_API_TOKEN — skipping digest email");
      progress.skip("digest", recipients.length === 0 ? "aucun destinataire" : "envoi d'email non configuré");
      return;
    }
    progress.start("digest");

    const newRelevant = await attachPublications(await getNewSinceLastDigest(runId, "relevant"));
    const upcoming = await attachPublications(await getUpcomingDeadlines(runId, digestWindow));
    const data = {
      newRelevant,
      upcoming,
      totalRelevant: nRelevant,
      totalTravaux: nTravaux,
      dashboardUrl: Bun.env.DASHBOARD_URL ?? null,
      dateStr: frDate(new Date()),
      llm: (llm ?? null) as LlmStats | null,
      warning: warning ?? null,
    };
    await sendEmail({
      to: recipients,
      subject: digestSubject(data),
      html: renderDigestHtml(data),
    });
    await markDigestSent(runId);
    console.error(`digest sent to ${recipients.length} recipient(s)`);
    progress.finish("digest", `${recipients.length} destinataire${recipients.length > 1 ? "s" : ""}`);
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`run #${runId} failed: ${msg}`);
    try {
      await finishRun(runId, { status: "error", error: msg });
    } catch (e) {
      console.error(`could not record failure: ${e}`);
    }
    await sendAlert("⚠️ Avis en cours — échec de la mise à jour quotidienne", renderAlertHtml(msg, frDate(new Date())));
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
