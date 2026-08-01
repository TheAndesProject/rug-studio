const express = require('express');
const cors = require('cors');
// Node 18+ has fetch built-in — no import needed

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ────────────────────────────────────────────────────────────────────
// Allow your GoDaddy frontend + local dev + Railway internal calls
// API keys are stored server-side so it is safe to allow all origins here
app.use(cors({
  origin: true,          // reflect any origin — keys never leave the server
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' }));

// ─── ENV VALIDATION ──────────────────────────────────────────────────────────
const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GOOGLE_API_KEY || !ANTHROPIC_API_KEY) {
  console.error('⚠️  Missing environment variables: GOOGLE_API_KEY and/or ANTHROPIC_API_KEY');
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Andes Project Rug Studio API',
    version: '1.0.0',
    endpoints: ['/api/generate-rug-visual', '/api/generate-image'],
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── STEP 2: GENERATE IMAGE VIA GEMINI 2.5 FLASH ────────────────────────────
// Uses generateContent with responseModalities: ["IMAGE", "TEXT"]
// Free tier: up to 500 images/day — no billing required.
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 20) {
    return res.status(400).json({ error: 'A valid prompt string is required' });
  }

  // Gemini 2.5 Flash image generation endpoint
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_API_KEY}`;

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
// Calls the shared helper functions directly — no internal HTTP self-fetch,
// which avoids Railway proxy issues.
// Build a precise, direct Gemini prompt from the rug config — no AI middleman.
// Every detail maps 1:1 from what the customer selected.
// Build the exact rug spec from customer selections
function buildRugSpec({ size, dims, shape, texture, pattern, colors, colorAssignment }) {
  const ca = colorAssignment || {};
  const shapeDesc = shape === 'round' ? 'round' : 'rectangular';

  const pompomColour = ca.pompom || '';
  const textureDesc = {
    plain:   'flat-woven smooth surface with tight even weave',
    pompom:  pompomColour
               ? `wool pom-pom texture — ${pompomColour} coloured wool tufts/balls densely covering the entire surface`
               : 'wool pom-pom texture — small wool tufts/balls densely covering the entire surface',
    cutpile: 'cut-pile with dense velvety pile surface',
  }[texture] || 'handwoven wool';

  let patternDesc = '';
  if (pattern === 'plain') {
    patternDesc = `SOLID — entire rug is one flat colour: ${ca.bg || colors[0] || 'natural'}. No pattern, no markings.`;
  } else if (pattern === 'stripes-h') {
    const c1 = ca.bg  || colors[0] || 'natural';
    const c2 = ca.alt || colors[1] || 'sand';
    patternDesc = `HORIZONTAL STRIPES — equal-width bands alternating strictly between ${c1} and ${c2}, running across the full width. No other colours.`;
  } else if (pattern === 'block') {
    const cTop = ca.top || colors[1] || 'sand';
    const cMid = ca.bg  || colors[0] || 'natural';
    const cBot = ca.bot || colors[2] || 'tobacco';
    patternDesc = `COLOUR BLOCK — exactly 3 horizontal sections: ${cTop} top band, wide ${cMid} centre, ${cBot} bottom band. Clean hard edges. No other colours.`;
  } else if (pattern === 'checkers') {
    const c1 = ca.bg  || colors[0] || 'natural';
    const c2 = ca.alt || colors[1] || 'black';
    patternDesc = `CHECKERBOARD — equal squares in a strict grid alternating between ${c1} and ${c2} only. No other colours.`;
  } else if (pattern === 'circle') {
    const bg  = ca.bg     || colors[0] || 'natural';
    const cir = ca.circle || colors[1] || 'sand';
    patternDesc = `CIRCLE CENTRE — flat solid ${bg} background. One large solid ${cir} circle perfectly centred. No border, no outline, no other elements.`;
  } else {
    const c1 = ca.bg  || colors[0] || 'natural';
    const c2 = ca.alt || colors[1] || 'sand';
    patternDesc = `CUSTOM GEOMETRIC — artisan pattern in ${c1} and ${c2}.`;
  }

  return { shapeDesc, textureDesc, patternDesc, dims };
}

// Claude turns the spec into vivid Gemini-optimised language —
// but is strictly forbidden from changing any design detail.
async function generatePrompt({ size, dims, shape, texture, pattern, colors, colorAssignment }) {
  const spec = buildRugSpec({ size, dims, shape, texture, pattern, colors, colorAssignment });

  const system = `You are a Gemini image generation prompt writer for luxury handwoven rugs. Your ONLY job is to turn a rug specification into a single vivid, photorealistic Gemini image prompt.

STRICT RULES:
1. Every design detail in the spec (pattern, colours, texture) MUST appear in your prompt verbatim — do not change, interpret or replace any colour name or pattern description
2. Do NOT add colours or design elements not listed in the spec
3. Do NOT use vague language like "earthy tones" — use the exact colour names given
4. Output ONLY the prompt text. No preamble, no explanation, no quotes.`;

  const user = `Write a Gemini image generation prompt for this handwoven Argentine wool rug:

SHAPE: ${spec.shapeDesc}
SIZE: ${spec.dims}
SURFACE TEXTURE: ${spec.textureDesc}
PATTERN & COLOURS: ${spec.patternDesc}

The prompt must:
- Reproduce the pattern and colours above with total accuracy — this is non-negotiable
- Place the rug in a beautiful aspirational living room: warm natural window light, wide-plank timber floors, neutral linen sofa softly visible, ceramic vase, indoor plant
- Describe the camera angle: slightly overhead 45 degrees, rug fills 70% of frame, ultra-sharp focus on rug surface revealing texture and colour, shallow depth of field behind
- End with: photorealistic interior photography, no people, no text, no watermarks`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-5',
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!response.ok) throw new Error(`Anthropic API error: ${await response.text()}`);
  const data   = await response.json();
  const prompt = data.content?.[0]?.text?.trim();
  if (!prompt) throw new Error('Empty response from Anthropic');
  return prompt;
}

async function generateImage(prompt) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_API_KEY}`;

  const response = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        temperature: 1,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${err}`);
  }

  const data      = await response.json();
  const parts     = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imagePart) throw new Error('No image returned from Gemini 2.5 Flash');

  return {
    image:    `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`,
    mimeType: imagePart.inlineData.mimeType,
  };
}

app.post('/api/generate-rug-visual', async (req, res) => {
  const { size, dims, shape, texture, pattern, colors, colorAssignment } = req.body;

  if (!colors || !Array.isArray(colors) || colors.length === 0) {
    return res.status(400).json({ error: 'colors array is required' });
  }

  try {
    // Step 1: Claude writes the photorealistic prompt
    const prompt = await generatePrompt({ size, dims, shape, texture, pattern, colors, colorAssignment });
    console.log('Generated prompt:', prompt);

    // Step 2: Gemini renders the image
    const { image, mimeType } = await generateImage(prompt);

    res.json({ prompt, image, mimeType });

  } catch (err) {
    console.error('generate-rug-visual error:', err);
    res.status(500).json({ error: err.message });
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
  console.log(`    Image model:       gemini-2.5-flash-image (free tier, 500 images/day)`);
  console.log(`    Google API key:    ${GOOGLE_API_KEY    ? '✓ set' : '✗ MISSING'}`);
  console.log(`    Anthropic API key: ${ANTHROPIC_API_KEY ? '✓ set' : '✗ MISSING'}`);
});
