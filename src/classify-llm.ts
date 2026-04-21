import type { Announcement } from "./scraper.ts";
import type { Classification } from "./classify.ts";

const API_URL = "https://api.mistral.ai/v1/chat/completions";

type Msg = { role: "system" | "user" | "assistant"; content: string };

type MistralChoice = { message: { content: string } };
type MistralResponse = { choices: MistralChoice[] };

const SYSTEM = `Tu classifies des avis de marché public français pour un cabinet de conseil en planification des mobilités.

SCOPE DU CABINET (→ "relevant"):
- Études de déplacements, analyse des usages et comportements, comptages et suivi des flux
- Plans de mobilité, schémas directeurs (cyclable, piéton, jalonnement, signalisation)
- Modélisation et simulation des mobilités
- Voirie, circulation, stationnement — côté études, pas gestion opérationnelle
- Réseaux cyclables/piétons, intermodalité — études et stratégies
- Transports collectifs et pôles d'échanges — études de faisabilité / opportunité
- Évaluation socio-économique de projets mobilité
- AMO (Assistance à Maîtrise d'Ouvrage) pour l'élaboration de plans, schémas, études

HORS SCOPE — TRAVAUX (→ "travaux"):
- Maîtrise d'œuvre (MOE) de conception ou d'exécution
- Rénovation / réhabilitation / restructuration / fouilles archéologiques / isolation
- Reconnaissance géotechnique
- AMO liée à la création / réalisation / construction d'un ouvrage physique (passerelle, pont, bâtiment, voirie, carrefour...) — subtil mais exclu: le cabinet ne répond pas quand l'AMO porte sur des travaux

HORS SCOPE — EXCLUDED (→ "excluded"):
- Contrôle de travaux (supervision de chantier)
- Contrôle de la qualité de service d'un transport existant (audit opérationnel, ≠ évaluation d'un plan)
- Télécom, téléphonie, réseau mobile, applications smartphone (ne pas confondre "mobilité" avec "mobile téléphone")
- VRD, détection / repérage de réseaux physiques, signalisation lumineuse tricolore maintenance
- Opérateurs de transport: autocars, chauffeurs, location de véhicules, transport scolaire ou de personnes, DSP d'exploitation
- Assurances, nettoyage / entretien, maintenance équipements / informatique, titres restaurant, agence de voyages
- Assainissement (eau), formation professionnelle, transport de fonds, paiement multicanal, IRVE (infrastructures recharge)
- Gestion opérationnelle du stationnement payant

RETOURNE UN JSON STRICT:
{"category": "relevant" | "travaux" | "excluded", "reason": "<phrase française ≤ 15 mots>"}

En cas de doute entre "relevant" et "excluded", privilégie "excluded".`;

const FEW_SHOT: Msg[] = [
  {
    role: "user",
    content:
      "Objet: Assistance à Maîtrise d'Ouvrage pour l'élaboration du Plan Local de Mobilité de la Communauté d'agglomération Paris-Saclay\nType d'avis: Avis de marché",
  },
  {
    role: "assistant",
    content:
      '{"category":"relevant","reason":"AMO pour élaboration d\'un Plan Local de Mobilité"}',
  },
  {
    role: "user",
    content:
      "Objet: ASSISTANCE A MAITRISE D'OUVRAGE RELATIVE A LA CREATION D'UNE PASSERELLE PIETONNE DANS LE SECTEUR DE MOULIN MER\nType d'avis: Avis de marché",
  },
  {
    role: "assistant",
    content:
      '{"category":"travaux","reason":"AMO liée à la création d\'un ouvrage physique (passerelle)"}',
  },
  {
    role: "user",
    content:
      "Objet: Contrôle de la qualité de service pour le service de transport à la demande destiné aux personnes en situation de handicap\nType d'avis: Avis de marché",
  },
  {
    role: "assistant",
    content:
      '{"category":"excluded","reason":"contrôle qualité d\'un service de transport existant"}',
  },
  {
    role: "user",
    content:
      "Objet: Mission de maîtrise d'œuvre pour la réalisation de la liaison cyclable de Breuillet à Taupignac\nType d'avis: Avis de marché",
  },
  {
    role: "assistant",
    content:
      '{"category":"travaux","reason":"MOE pour travaux d\'infrastructure cyclable"}',
  },
  {
    role: "user",
    content:
      "Objet: Schéma directeur cyclable départemental et études de faisabilité associées\nType d'avis: Avis de marché",
  },
  {
    role: "assistant",
    content:
      '{"category":"relevant","reason":"schéma directeur cyclable + études de faisabilité"}',
  },
];

function formatUser(a: Announcement): string {
  return [
    `Objet: ${a.objet}`,
    `Type d'avis: ${a.typeAvis}`,
    `Acheteur: ${a.acheteur}`,
    `Procédure: ${a.procedure}`,
    `Contexte: ${a.raw.slice(0, 1200)}`,
  ].join("\n");
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

async function postWithRetry(body: string, key: string, attempt = 1): Promise<MistralResponse> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body,
  });
  if (res.ok) return (await res.json()) as MistralResponse;

  if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
    const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 400;
    await new Promise((r) => setTimeout(r, backoff));
    return postWithRetry(body, key, attempt + 1);
  }
  throw new Error(`Mistral ${res.status}: ${await res.text()}`);
}

export async function classifyLLM(a: Announcement): Promise<Classification> {
  const key = Bun.env.MISTRAL_API_KEY;
  if (!key) throw new Error("MISTRAL_API_KEY not set");
  const model = Bun.env.MISTRAL_MODEL ?? "mistral-small-latest";

  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    ...FEW_SHOT,
    { role: "user", content: formatUser(a) },
  ];

  const body = JSON.stringify({
    model,
    messages,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const data = await postWithRetry(body, key);
  const content = data.choices[0]?.message.content ?? "{}";

  const parsed = JSON.parse(content) as { category?: string; reason?: string };
  const cat = parsed.category;
  if (cat !== "relevant" && cat !== "travaux" && cat !== "excluded") {
    throw new Error(`Invalid category from LLM: ${JSON.stringify(parsed)}`);
  }

  return { category: cat, reason: parsed.reason };
}
