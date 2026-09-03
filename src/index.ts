import { runPipeline } from "./pipeline.ts";
import { renderMarkdown } from "./report.ts";
import { llmStatsSummary } from "./llm.ts";

async function main() {
  const { relevant, travaux, excluded, llm, warning } = await runPipeline({
    query: Bun.argv.slice(2).join(" ").trim() || undefined,
    maxPages: Bun.env.MAX_PAGES ? Number(Bun.env.MAX_PAGES) : undefined,
    useCache: Bun.env.USE_CACHE === "1",
    classifier: Bun.env.CLASSIFIER,
  });

  const now = new Date();
  const generatedAt = now.toISOString();
  const stamp = generatedAt.slice(0, 19).replace(/[T:]/g, "-");

  const relevantPath = `avis-en-cours-${stamp}.md`;
  const travauxPath = `avis-travaux-${stamp}.md`;

  await Bun.write(
    relevantPath,
    renderMarkdown(relevant, {
      title: "Avis en cours — scope principal (études de mobilité)",
      subtitle:
        "Filtres: `type_marche=SERVICES`, statut *en cours*, toutes départements. " +
        "Exclus: contrôle de travaux, services télécom/téléphonie. " +
        `Les avis de type *travaux* sont dans \`${travauxPath}\`.`,
      generatedAt,
    }),
  );

  await Bun.write(
    travauxPath,
    renderMarkdown(travaux, {
      title: "Avis — travaux (hors scope du cabinet)",
      subtitle:
        "Avis contenant des mots-clés *travaux* (MOE, rénovation, fouilles, isolation…). " +
        "Listés à titre indicatif — le cabinet ne fait pas de travaux.",
      generatedAt,
    }),
  );

  console.error("\n=== classification ===");
  console.error(`relevant: ${relevant.length}   travaux: ${travaux.length}   excluded: ${excluded.length}`);
  if (excluded.length > 0) {
    console.error("\nexcluded:");
    for (const e of excluded) {
      console.error(`  - [${e.idweb}] ${e.reason} — ${e.objet.slice(0, 80)}`);
    }
  }
  if (llm) {
    console.error("\n=== LLM (OpenRouter) ===");
    console.error(llmStatsSummary(llm));
    console.error(
      `tokens: ${llm.promptTokens} in / ${llm.completionTokens} out` +
        (llm.breakerTripped ? `\ncoupe-circuit: ${llm.breakerReason}` : ""),
    );
  }
  if (warning) console.error(`\n⚠️  ${warning}`);
  console.error(`\nwrote ${relevantPath} (${relevant.length}) and ${travauxPath} (${travaux.length})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
