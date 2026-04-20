import type { Announcement } from "./scraper.ts";
import { classify as classifyRegex, type Classification } from "./classify.ts";
import { classifyLLM } from "./classify-llm.ts";

export async function classifyHybrid(a: Announcement): Promise<Classification> {
  const regex = classifyRegex(a);
  if (regex.category !== "relevant") return regex;
  return classifyLLM(a);
}
