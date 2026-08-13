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

if (!GOOGLE_API_KEY) {
  console.error('⚠️  Missing environment variable: GOOGLE_API_KEY');
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
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${GOOGLE_API_KEY}`;

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

// Build the final Gemini prompt directly — no AI middleman for the design spec.
// The pattern and colour instructions come first so Gemini prioritises them.
function generatePrompt({ size, dims, shape, texture, pattern, colors, colorAssignment }) {
  const spec = buildRugSpec({ size, dims, shape, texture, pattern, colors, colorAssignment });

  // Pattern instruction — placed at the very start so Gemini reads it first
  const patternInstruction = {
    plain:     `The rug is a single flat solid colour with absolutely no pattern. ${spec.patternDesc}`,
    'stripes-h': `The rug has bold horizontal stripes only — NOT vertical, NOT diagonal. ${spec.patternDesc}`,
    block:     `The rug has exactly three horizontal colour blocks from top to bottom. ${spec.patternDesc}`,
    checkers:  `The rug has a checkerboard pattern of equal squares. ${spec.patternDesc}`,
    circle:    `The rug has a single large circle in the centre on a plain background. ${spec.patternDesc}`,
    custom:    spec.patternDesc,
  }[pattern] || spec.patternDesc;

  return [
    // Lead with the design — most important instruction goes first
    `IMPORTANT: Generate a photorealistic image of a handwoven wool rug with this EXACT design:`,
    `Pattern: ${patternInstruction}`,
    `Surface texture: ${spec.textureDesc}`,
    `Shape: ${spec.shapeDesc}, size ${spec.dims}`,
    ``,
    // Scene second
    `The rug is lying flat on wide-plank warm timber floors in a beautiful living room.`,
    `Soft natural window light. A neutral linen sofa is softly visible at the top of the frame.`,
    `Simple ceramic vase and indoor plant in the background.`,
    ``,
    // Camera third
    `Camera angle: 45-degree overhead view looking down at the rug.`,
    `The rug fills 70% of the frame. Ultra-sharp focus on the rug surface showing every thread, fibre and colour clearly.`,
    `Shallow depth of field — background furniture is softly blurred.`,
    ``,
    // Constraints last
    `Photorealistic interior photography. No people. No text. No watermarks. No illustrations.`,
    `The rug pattern and colours must match the specification above exactly.`,
  ].join(' ');
}

async function generateImage(prompt) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${GOOGLE_API_KEY}`;

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
    const prompt = generatePrompt({ size, dims, shape, texture, pattern, colors, colorAssignment });
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
  console.log(`    Image model:       gemini-3-pro-image (free tier, 500 images/day)`);
  console.log(`    Google API key:    ${GOOGLE_API_KEY    ? '✓ set' : '✗ MISSING'}`);
});
