import { runPipeline } from "./pipeline.ts";
import {
  migrate,
  tryAcquireRunLock,
  startRun,
  finishRun,
  upsertAnnouncements,
  getNewInRun,
  getUpcomingDeadlines,
} from "./db.ts";
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
    const { relevant, travaux, excluded } = await runPipeline({
      maxPages: Bun.env.MAX_PAGES ? Number(Bun.env.MAX_PAGES) : undefined,
      classifier: Bun.env.CLASSIFIER,
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

    // Recipients = users who opted in on /profil.
    const recipients = uniqueEmails([await getDigestUserEmails()]);
    if (recipients.length === 0 || !hasEmailToken()) {
      console.error("no opted-in digest recipients or no MAILPACE_API_TOKEN — skipping digest email");
      return;
    }

    const newRelevant = await getNewInRun(runId, "relevant");
    const upcoming = await getUpcomingDeadlines(runId, 14);
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
