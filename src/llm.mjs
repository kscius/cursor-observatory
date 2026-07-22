import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mergeLlmRecommendations } from "./recommend.mjs";

const SYSTEM_PROMPT = `You are a Cursor usage coach. Given JSON analytics from a local observatory dashboard, produce concise, actionable recommendations for ONE section only.

Respond with valid JSON only (no markdown):
{
  "summary": "2-3 sentences explaining what the data means for this user",
  "actions": ["specific action 1", "specific action 2", "specific action 3"]
}

Be direct, privacy-aware (data stays local), and never invent numbers not in the input.`;

function cacheKey(section, payload) {
  const h = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  return `${section}-${h}`;
}

function readCache(cacheDir) {
  const f = path.join(cacheDir, "llm-recommendations.json");
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cacheDir, data) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const targetPath = path.join(cacheDir, "llm-recommendations.json");
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  const contents = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, contents, "utf8");
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Windows may refuse rename over an existing file; fall back to copy.
    if (process.platform !== "win32" || !fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
    try {
      fs.copyFileSync(tmpPath, targetPath);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}

async function callOpenAI(config, userPrompt) {
  const apiKey = process.env[config.apiKeyEnv || "OPENAI_API_KEY"];
  if (!apiKey) throw new Error(`Missing ${config.apiKeyEnv || "OPENAI_API_KEY"}`);

  const res = await fetch(`${config.baseUrl || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 600,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(text);
}

function buildSectionPrompt(sectionKey, sectionData, reportSummary) {
  return JSON.stringify(
    {
      section: sectionKey,
      sectionData,
      context: {
        fluency: reportSummary.fluency,
        archetype: reportSummary.archetype,
        totalInput: reportSummary.input_tokens,
        sessions: reportSummary.sessions,
      },
    },
    null,
    2
  );
}

export async function enrichWithLlm(report, deterministic, config) {
  if (!config?.enabled) return deterministic;

  const apiKeyEnv = config.apiKeyEnv || "OPENAI_API_KEY";
  if (!process.env[apiKeyEnv]) return deterministic;

  const cacheDir = path.join(config.cacheDir || "", "cache");
  const cache = config.useCache !== false ? readCache(cacheDir) : {};
  const llmSections = {};
  const reportSummary = {
    fluency: report.behavior?.fluency_score,
    archetype: report.behavior?.archetype,
    input_tokens: report.totals?.input_tokens,
    sessions: report.totals?.sessions,
  };

  const keys = config.sections || ["behavior", "overview", "usage", "sessions", "tools"];

  for (const key of keys) {
    const sectionData = deterministic.sections[key];
    if (!sectionData) continue;

    const ck = cacheKey(key, sectionData);
    if (cache[ck]) {
      llmSections[key] = cache[ck];
      continue;
    }

    try {
      const prompt = buildSectionPrompt(key, sectionData, reportSummary);
      const result = await callOpenAI(config, prompt);
      cache[ck] = { ...result, cachedAt: new Date().toISOString() };
      llmSections[key] = result;
    } catch (err) {
      llmSections[key] = { summary: null, actions: [], error: err.message };
    }
  }

  if (config.useCache !== false) writeCache(cacheDir, cache);
  return mergeLlmRecommendations(deterministic, llmSections);
}
