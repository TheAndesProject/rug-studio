// Rug Studio — Backend Proxy
// Requires: npm install express cors node-fetch @google/genai
// Run with: ANTHROPIC_API_KEY=sk-ant-... GOOGLE_API_KEY=AIza... node server.js

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}
if (!GOOGLE_API_KEY) {
  console.error('ERROR: GOOGLE_API_KEY environment variable is not set.');
  console.error('Get a free key at https://aistudio.google.com/apikey');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

app.use(cors({ origin: '*' })); // Restrict to your domain in production
app.use(express.json());


// ── Step 1: Generate prompt via Claude ──────────────────────────────────────
app.post('/api/generate-prompt', async (req, res) => {
  const { style, colour, material, size, shape, notes } = req.body;

  const userMessage = `Create a detailed image generation prompt for a photorealistic rug with these specifications:
- Style: ${style}
- Primary colour: ${colour}
- Material: ${material}
- Size: ${size} ${shape}
- Setting: in a warm, beautifully styled living area with natural light, lifestyle photography
${notes ? '- Additional details: ' + notes : ''}

The prompt must produce a photorealistic, high-quality render suitable for an e-commerce rug visualiser. 
Include: specific living room context, furniture, natural lighting from windows, texture detail, pile depth, 
weave pattern visibility, colour accuracy, and material sheen. 
End with quality tags: "8K resolution, photorealistic, interior design photography, sharp focus, professional lighting".
Reply with ONLY the image prompt, nothing else.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: 'You are an expert AI art director specialising in photorealistic rug and textile interior photography. You write precise, vivid image generation prompts that capture material texture, weave patterns, pile depth, lighting, and colour in a real living space. Your prompts consistently produce gallery-quality, e-commerce-ready renders.',
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'Claude error' });
    }

    const data = await response.json();
    const prompt = data.content.map(b => b.text || '').join('').trim();
    res.json({ prompt });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Step 2: Generate image via Google Imagen 4 (hardcoded) ──────────────────
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) return res.status(400).json({ error: 'No prompt provided' });

  try {
    const response = await ai.models.generateImages({
      model: 'imagen-4.0-generate-001',   // Hardcoded — always Imagen 4
      prompt,
      config: {
        numberOfImages: 1,
        aspectRatio: '16:9',              // Landscape for living room scenes
        personGeneration: 'dont_allow',   // Rugs only — no people needed
      },
    });

    const imageBytes = response.generatedImages[0].image.imageBytes;

    // Imagen returns base64 — send as a data URL the frontend can display directly
    const dataUrl = `data:image/png;base64,${imageBytes}`;
    res.json({ url: dataUrl });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Rug Studio proxy running on http://localhost:${PORT}`);
  console.log('Google Imagen 4 hardcoded | 16:9 landscape | Gemini API');
});
