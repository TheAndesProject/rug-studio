const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ────────────────────────────────────────────────────────────────────
// Allow your GoDaddy frontend + local dev
const ALLOWED_ORIGINS = [
  'https://theandesproject.com.au',
  'https://www.theandesproject.com.au',
  'http://localhost',
  'http://localhost:3000',
  'http://127.0.0.1',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' }));

// ─── ENV VALIDATION ──────────────────────────────────────────────────────────
const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GOOGLE_API_KEY || !ANTHROPIC_API_KEY) {
  console.error('⚠️  Missing environment variables: GOOGLE_API_KEY and/or ANTHROPIC_API_KEY');
  console.error('    Set these in Railway → Variables before deploying.');
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Andes Project Rug Studio API',
    version: '1.0.0',
    endpoints: ['/api/generate-prompt', '/api/generate-image', '/api/generate-rug-visual'],
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── STEP 1: GENERATE IMAGEN PROMPT VIA CLAUDE ───────────────────────────────
// Accepts rug config, returns a photorealistic prompt string
app.post('/api/generate-prompt', async (req, res) => {
  const { size, dims, shape, texture, pattern, colors } = req.body;

  if (!colors || !Array.isArray(colors) || colors.length === 0) {
    return res.status(400).json({ error: 'colors array is required' });
  }

  const colorList  = colors.join(', ');
  const shapeLabel = shape === 'round' ? 'round' : 'rectangular';
  const textureMap = {
    plain:   'flat-woven with a smooth, tight weave',
    pompom:  'featuring tactile wool pom-pom tufts across the surface',
    cutpile: 'with a dense, velvety cut-pile surface',
  };
  const patternMap = {
    plain:      'a solid single-colour field',
    'stripes-h':'bold horizontal stripes',
    'stripes-v':'clean vertical stripes',
    block:      'a colour-block design with distinct banded sections',
    checkers:   'a classic checkerboard pattern',
    custom:     'an artisan geometric pattern',
  };

  const textureDesc = textureMap[texture]  || 'handwoven';
  const patternDesc = patternMap[pattern]  || 'a beautiful pattern';

  const systemPrompt = `You are a luxury interior photography prompt engineer specialising in photorealistic AI image generation for high-end home goods. You write precise, vivid Imagen 4 prompts that produce stunning editorial-quality images. Always respond with ONLY the prompt text — no preamble, no explanation, no quotes.`;

  const userMessage = `Write a single photorealistic Imagen 4 prompt for a luxury handwoven Argentine wool rug with these exact specifications:
- Shape: ${shapeLabel}
- Size: ${dims}
- Texture: ${textureDesc}
- Pattern: ${patternDesc}
- Colour palette: ${colorList} (natural wool dye tones)

The prompt must place the rug in a beautiful, aspirational living room setting — warm natural light, timber floors, linen or bouclé furniture, styled with plants and ceramics. The rug itself must be the hero of the image, showing fine weave detail, wool texture, and the exact colours specified. Editorial interior photography style, shot from a slightly elevated 45-degree angle, ultra-sharp focus on the rug, shallow depth of field on the background. Photorealistic, 8K quality, no text or watermarks.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(502).json({ error: 'Anthropic API error', detail: err });
    }

    const data   = await response.json();
    const prompt = data.content?.[0]?.text?.trim();

    if (!prompt) {
      return res.status(502).json({ error: 'Empty response from Anthropic' });
    }

    res.json({ prompt });

  } catch (err) {
    console.error('generate-prompt error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ─── STEP 2: GENERATE IMAGE VIA GEMINI 2.5 FLASH ────────────────────────────
// Uses generateContent with responseModalities: ["IMAGE", "TEXT"]
// Free tier: up to 500 images/day — no billing required.
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 20) {
    return res.status(400).json({ error: 'A valid prompt string is required' });
  }

  // Gemini 2.5 Flash image generation endpoint
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GOOGLE_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt.trim() }],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 1,
    },
  };

  try {
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Gemini 2.5 Flash error:', err);
      return res.status(502).json({ error: 'Google Gemini API error', detail: err });
    }

    const data = await response.json();

    // Response parts may contain TEXT and/or INLINE_DATA (image) blocks
    const parts     = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imagePart) {
      console.error('Gemini response had no image part:', JSON.stringify(data, null, 2));
      return res.status(502).json({ error: 'No image returned from Gemini 2.5 Flash' });
    }

    const imageBase64 = imagePart.inlineData.data;
    const mimeType    = imagePart.inlineData.mimeType || 'image/png';

    res.json({
      image: `data:${mimeType};base64,${imageBase64}`,
      mimeType,
      prompt,
    });

  } catch (err) {
    console.error('generate-image error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ─── COMBINED: GENERATE PROMPT + IMAGE IN ONE CALL ───────────────────────────
// The frontend can call this single endpoint for convenience
app.post('/api/generate-rug-visual', async (req, res) => {
  const { size, dims, shape, texture, pattern, colors } = req.body;

  if (!colors || !Array.isArray(colors) || colors.length === 0) {
    return res.status(400).json({ error: 'colors array is required' });
  }

  try {
    // Step 1: Generate prompt via Claude
    const promptRes = await fetch(`http://localhost:${PORT}/api/generate-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size, dims, shape, texture, pattern, colors }),
    });

    if (!promptRes.ok) {
      const err = await promptRes.json();
      return res.status(502).json({ error: 'Prompt generation failed', detail: err });
    }

    const { prompt } = await promptRes.json();

    // Step 2: Generate image via Gemini 2.5 Flash
    const imageRes = await fetch(`http://localhost:${PORT}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    if (!imageRes.ok) {
      const err = await imageRes.json();
      return res.status(502).json({ error: 'Image generation failed', detail: err });
    }

    const imageData = await imageRes.json();

    res.json({
      prompt: imageData.prompt,
      image:  imageData.image,
      mimeType: imageData.mimeType,
    });

  } catch (err) {
    console.error('generate-rug-visual error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ─── 404 FALLBACK ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.message.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Andes Project Rug Studio API running on port ${PORT}`);
  console.log(`    Image model:       gemini-2.5-flash-preview-05-20 (free tier, 500 images/day)`);
  console.log(`    Google API key:    ${GOOGLE_API_KEY    ? '✓ set' : '✗ MISSING'}`);
  console.log(`    Anthropic API key: ${ANTHROPIC_API_KEY ? '✓ set' : '✗ MISSING'}`);
});
