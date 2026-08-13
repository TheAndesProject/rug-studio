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
// Generate a prompt for an EMPTY room — no rug.
// The rug will be composited on top accurately in the browser.
function generatePrompt({ size, dims, shape, texture, pattern, colors, colorAssignment }) {
  return [
    `Photorealistic interior design photograph of a beautiful aspirational living room.`,
    `Wide-plank warm oak timber floors — the floor must be COMPLETELY CLEAR and EMPTY in the centre-foreground of the image, with no rug, no furniture, no objects on the floor.`,
    `A neutral linen sofa sits against the back wall. Soft warm natural window light from the left.`,
    `A simple tall ceramic vase and a small indoor plant are visible near the sofa.`,
    `Muted warm neutral wall colour. Minimal, elegant Scandinavian-meets-Argentine interior style.`,
    `Camera angle: slightly elevated 45-degree view looking into the room. The empty timber floor fills the lower 60% of the frame.`,
    `Photorealistic, editorial interior photography quality. No people. No text. No watermarks.`,
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
