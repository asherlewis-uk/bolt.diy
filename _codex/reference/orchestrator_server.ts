import express from 'express';

type Role = 'system' | 'user' | 'assistant';
type Message = { role: Role; content: string };

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 8787);
const API_BASE = (process.env.OPENAI_LIKE_API_BASE_URL || 'https://ollama.com/v1').replace(/\/$/, '');
const API_KEY = process.env.OPENAI_LIKE_API_KEY || '';
const ARCHITECT_MODEL = process.env.ARCHITECT_MODEL || 'deepseek-v3.1:671b-cloud';
const BUILDER_MODEL = process.env.BUILDER_MODEL || 'qwen3-coder-next:cloud';
const CRITIC_MODEL = process.env.CRITIC_MODEL || 'nemotron-3-super:cloud';
const SYNTHESIZER_MODEL = process.env.SYNTHESIZER_MODEL || ARCHITECT_MODEL;

async function callModel(model: string, messages: Message[], temperature = 0.3) {
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  });

  const data = await response.json() as any;
  if (!response.ok) throw new Error(data?.error?.message || `Model call failed: ${response.status}`);
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, port: PORT, apiBase: API_BASE });
});

app.post('/orchestrate', async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const projectBrief = String(req.body?.projectBrief || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'Missing prompt' });

    const brief = `PROJECT BRIEF\n${projectBrief || 'No separate project brief provided.'}\n\nUSER REQUEST\n${prompt}`;

    const architect = await callModel(ARCHITECT_MODEL, [
      { role: 'system', content: 'You are the ARCHITECT. Output a concrete v1 implementation plan. No code.' },
      { role: 'user', content: brief }
    ]);

    const builder = await callModel(BUILDER_MODEL, [
      { role: 'system', content: 'You are the BUILDER. Produce code-oriented implementation output.' },
      { role: 'user', content: `${brief}\n\nARCHITECT PLAN\n${architect}` }
    ]);

    const critic = await callModel(CRITIC_MODEL, [
      { role: 'system', content: 'You are the CRITIC. Find real flaws and give a minimal patch plan.' },
      { role: 'user', content: `${brief}\n\nARCHITECT PLAN\n${architect}\n\nBUILDER OUTPUT\n${builder}` }
    ]);

    const synthesis = await callModel(SYNTHESIZER_MODEL, [
      { role: 'system', content: 'You are the FINAL DECIDER. Synthesize the best next action plan.' },
      { role: 'user', content: `${brief}\n\nARCHITECT PLAN\n${architect}\n\nBUILDER OUTPUT\n${builder}\n\nCRITIC REVIEW\n${critic}` }
    ]);

    res.json({ ok: true, architect, builder, critic, synthesis });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || 'Unknown error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`orchestrator listening on 0.0.0.0:${PORT}`);
});
