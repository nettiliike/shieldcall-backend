require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const admin = require('firebase-admin');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COLLECTION = process.env.FIRESTORE_COLLECTION || 'calls';

// --- OpenAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Firebase Admin ---
function initFirebase() {
  if (admin.apps.length) return;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
   const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    return;
  }

  // Works on Google/Firebase hosting environments with default credentials.
  admin.initializeApp();
}

initFirebase();
const db = admin.firestore();

function maskPhone(number = '') {
  if (!number) return 'Tuntematon';
  // Keep beginning and last 2 digits visible: +35840*****67
  return number.replace(/(\+?\d{3,6})\d+(\d{2})$/, '$1*****$2');
}

function normalizeJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) {}
    }
    return null;
  }
}

async function analyzeCall({ speechResult, caller }) {
  const prompt = `
Olet suomalaisen AI-puhelinvastaajan analyysimoottori.
Soittaja kertoi seuraavan asian:
"""
${speechResult || ''}
"""

Palauta VAIN validi JSON seuraavilla kentillä:
{
  "callerName": "soittajan nimi jos ilmenee, muuten Tuntematon",
  "summary": "1-2 virkkeen suomenkielinen yhteenveto",
  "category": "tärkeä | normaali | myynti | huijaus | epäselvä",
  "priority": "korkea | keskitaso | matala",
  "recommendedAction": "soita takaisin heti | soita takaisin myöhemmin | ei vaadi toimenpidettä | tarkista varoen",
  "spamRisk": 0-100
}

Luokittele tärkeäksi, jos asia vaikuttaa asiakkaalta, työasialta, varaukselta, tarjoukselta, toimitukselta, laskulta tai kiireelliseltä henkilökohtaiselta asialta.
Luokittele myynniksi tai huijaukseksi vain jos siihen on selkeä syy.
`;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'Vastaa aina pelkkänä JSONina. Ei markdownia.' },
      { role: 'user', content: prompt }
    ],
  });

  const content = completion.choices?.[0]?.message?.content || '{}';
  const parsed = normalizeJson(content);

  return parsed || {
    callerName: 'Tuntematon',
    summary: speechResult ? speechResult.slice(0, 220) : 'Soittaja ei jättänyt selkeää viestiä.',
    category: 'epäselvä',
    priority: 'matala',
    recommendedAction: 'tarkista varoen',
    spamRisk: 50,
  };
}

// Health check
app.get('/', (req, res) => {
  res.send('AI Puhelinvastaaja backend toimii ✅');
});
app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/dashboard-ai-voicemail.html');
});
// Twilio Voice webhook: A Call Comes In
app.post('/voice', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: 'speech',
    language: 'fi-FI',
    speechTimeout: 'auto',
    timeout: 5,
    action: '/voice/process',
    method: 'POST',
  });

  gather.say({ language: 'fi-FI', voice: 'Polly.Suvi' },
    'Hei. Tavoitit puhelinassistentin. Henkilö ei pääse juuri nyt vastaamaan, mutta voin välittää viestin. Kerro lyhyesti nimesi ja mitä asia koskee.'
  );

  twiml.say({ language: 'fi-FI', voice: 'Polly.Suvi' },
    'En valitettavasti kuullut viestiä. Voit yrittää myöhemmin uudelleen. Kiitos soitosta.'
  );

  res.type('text/xml').send(twiml.toString());
});

// Twilio sends speech result here
app.post('/voice/process', async (req, res) => {
  const caller = req.body.From || '';
  const called = req.body.To || '';
  const callSid = req.body.CallSid || '';
  const speechResult = req.body.SpeechResult || '';
  const confidence = req.body.Confidence || null;

  let analysis;

  try {
    analysis = await analyzeCall({ speechResult, caller });

    await db.collection(COLLECTION).add({
      type: 'ai_voicemail',
      callSid,
      fromMasked: maskPhone(caller),
      fromRaw: process.env.STORE_RAW_CALLER === 'true' ? caller : null,
      toNumber: called,
      transcript: process.env.STORE_TRANSCRIPT === 'true' ? speechResult : null,
      transcriptPreview: speechResult ? speechResult.slice(0, 500) : '',
      callerName: analysis.callerName || 'Tuntematon',
      summary: analysis.summary || 'Ei yhteenvetoa.',
      category: analysis.category || 'epäselvä',
      priority: analysis.priority || 'matala',
      recommendedAction: analysis.recommendedAction || 'tarkista varoen',
      spamRisk: Number(analysis.spamRisk ?? 50),
      speechConfidence: confidence,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('Call processing failed:', error);

    await db.collection(COLLECTION).add({
      type: 'ai_voicemail_error',
      callSid,
      fromMasked: maskPhone(caller),
      toNumber: called,
      transcriptPreview: speechResult ? speechResult.slice(0, 500) : '',
      summary: 'Puhelun analysointi epäonnistui, mutta viesti vastaanotettiin.',
      category: 'epäselvä',
      priority: 'matala',
      recommendedAction: 'tarkista varoen',
      error: String(error.message || error),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ language: 'fi-FI', voice: 'Polly.Suvi' },
    'Kiitos. Välitän viestin eteenpäin. Mukavaa päivänjatkoa.'
  );
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`AI Puhelinvastaaja backend käynnissä portissa ${PORT}`);
});
