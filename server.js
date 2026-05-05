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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function initFirebase() {
  if (admin.apps.length) return;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    admin.initializeApp();
  }
}

initFirebase();
const db = admin.firestore();

function maskPhone(number = '') {
  if (!number) return 'Tuntematon';
  return number.replace(/(\+?\d{3,6})\d+(\d{2})$/, '$1*****$2');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function analyzeCall(speechResult) {
  const prompt = `
Analysoi tämä puhelinvastaajaan jätetty viesti suomeksi:

"${speechResult}"

Palauta VAIN validi JSON tässä muodossa:
{
  "callerName": "soittajan nimi jos ilmenee, muuten Tuntematon",
  "summary": "lyhyt 1-2 virkkeen yhteenveto",
  "category": "tärkeä | normaali | myynti | huijaus | epäselvä",
  "priority": "korkea | keskitaso | matala",
  "recommendedAction": "soita takaisin heti | soita takaisin myöhemmin | ei vaadi toimenpidettä | tarkista varoen",
  "spamRisk": 0
}
`;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'Vastaa aina pelkkänä validina JSONina. Älä käytä markdownia.' },
      { role: 'user', content: prompt },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || '{}';
  const parsed = safeJsonParse(content);

  return parsed || {
    callerName: 'Tuntematon',
    summary: speechResult || 'Soittaja ei jättänyt selkeää viestiä.',
    category: 'epäselvä',
    priority: 'matala',
    recommendedAction: 'tarkista varoen',
    spamRisk: 50,
  };
}

function formatDate(value) {
  if (!value) return '';
  if (value.toDate) return value.toDate().toLocaleString('fi-FI');
  return String(value);
}

app.get('/', (req, res) => {
  res.send('AI Puhelinvastaaja backend toimii ✅');
});

app.get('/dashboard', async (req, res) => {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const rows = snapshot.docs.map(doc => {
      const d = doc.data();
      const risk = Number(d.spamRisk || 0);

      return `
        <div class="card ${d.type === 'ai_voicemail_error' ? 'error' : ''}">
          <div class="top">
            <h2>${d.category || 'Ei luokitusta'}</h2>
            <span class="risk">Riski ${risk}/100</span>
          </div>

          <p><b>Aika:</b> ${formatDate(d.createdAt)}</p>
          <p><b>Soittaja:</b> ${d.from || d.fromMasked || 'Tuntematon'}</p>
          <p><b>Nimi:</b> ${d.callerName || 'Tuntematon'}</p>
          <p><b>Kiireellisyys:</b> ${d.priority || '-'}</p>
          <p><b>Suositus:</b> ${d.recommendedAction || '-'}</p>
          <p><b>Yhteenveto:</b> ${d.summary || '-'}</p>
          <p><b>Puheen sisältö:</b> ${d.transcript || '-'}</p>
          ${d.error ? `<p class="err"><b>Virhe:</b> ${d.error}</p>` : ''}
        </div>
      `;
    }).join('');

    res.send(`
      <!doctype html>
      <html lang="fi">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>AI Puhelinvastaaja Dashboard</title>
        <style>
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #0f172a;
            color: #111827;
          }
          header {
            background: #111827;
            color: white;
            padding: 24px;
            text-align: center;
          }
          main {
            max-width: 1000px;
            margin: 0 auto;
            padding: 24px;
          }
          .card {
            background: #dcfce7;
            border-radius: 18px;
            padding: 22px;
            margin-bottom: 18px;
            box-shadow: 0 8px 20px rgba(0,0,0,0.18);
          }
          .card.error {
            background: #fee2e2;
          }
          .top {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: center;
          }
          h1, h2 {
            margin: 0;
          }
          h2 {
            font-size: 26px;
          }
          p {
            font-size: 17px;
            line-height: 1.45;
          }
          .risk {
            background: #16a34a;
            color: white;
            padding: 10px 16px;
            border-radius: 999px;
            font-weight: bold;
          }
          .err {
            color: #991b1b;
          }
          .empty {
            background: white;
            padding: 24px;
            border-radius: 14px;
          }
        </style>
      </head>
      <body>
        <header>
          <h1>AI Puhelinvastaaja Dashboard</h1>
          <p>Viimeisimmät puhelut ja AI-yhteenvedot</p>
        </header>
        <main>
          ${rows || '<div class="empty">Ei puheluita vielä.</div>'}
        </main>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Dashboardin lataus epäonnistui: ' + error.message);
  }
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: 'speech',
    language: 'fi-FI',
    speechTimeout: 'auto',
    timeout: 6,
    action: '/voice/process',
    method: 'POST',
  });

  gather.say(
    { language: 'fi-FI' },
    'Hei, tavoitit puhelinassistentin. Henkilö ei pääse juuri nyt vastaamaan. Kerro nimesi ja asiasi lyhyesti, niin välitän viestin eteenpäin.'
  );

  twiml.say(
    { language: 'fi-FI' },
    'En valitettavasti kuullut viestiä. Voit yrittää myöhemmin uudelleen. Kiitos soitosta.'
  );

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/process', async (req, res) => {
  const speechResult = req.body.SpeechResult || '';
  const caller = req.body.From || 'Tuntematon';
  const called = req.body.To || '';
  const callSid = req.body.CallSid || '';

  console.log('Puhe vastaanotettu:', speechResult);

  try {
    const analysis = await analyzeCall(speechResult);

    await db.collection(COLLECTION).add({
      type: 'ai_voicemail',
      callSid,
      from: caller,
      fromMasked: maskPhone(caller),
      toNumber: called,
      transcript: speechResult,
      callerName: analysis.callerName || 'Tuntematon',
      summary: analysis.summary || 'Ei yhteenvetoa.',
      category: analysis.category || 'epäselvä',
      priority: analysis.priority || 'matala',
      recommendedAction: analysis.recommendedAction || 'tarkista varoen',
      spamRisk: Number(analysis.spamRisk || 0),
      action: 'AI vastaanotti viestin',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('Puhelun analysointi/tallennus epäonnistui:', error);

    await db.collection(COLLECTION).add({
      type: 'ai_voicemail_error',
      callSid,
      from: caller,
      fromMasked: maskPhone(caller),
      toNumber: called,
      transcript: speechResult,
      summary: speechResult || 'Puhelun analysointi epäonnistui.',
      category: 'epäselvä',
      priority: 'matala',
      recommendedAction: 'tarkista varoen',
      spamRisk: 50,
      error: String(error.message || error),
      action: 'Virhe analyysissä',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { language: 'fi-FI' },
    'Kiitos. Viesti on vastaanotettu ja välitetään eteenpäin. Mukavaa päivänjatkoa.'
  );

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`AI Puhelinvastaaja backend käynnissä portissa ${PORT}`);
});
