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

// Firebase init
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
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
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
      {
        role: 'system',
        content: 'Vastaa aina pelkkänä validina JSONina. Älä käytä markdownia.',
      },
      {
        role: 'user',
        content: prompt,
      },
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

// Health check
app.get('/', (req, res) => {
  res.send('AI Puhelinvastaaja backend toimii ✅');
});

// Twilio: puhelu alkaa
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

// Twilio: puhe käsitellään
app.post('/voice/process', async (req, res) => {
  const speechResult = req.body.SpeechResult || '';
  const caller = req.body.From || 'Tuntematon';
  const called = req.body.To || '';
  const callSid = req.body.CallSid || '';

  console.log('Puhe vastaanotettu:', speechResult);

  let analysis;

  try {
    analysis = await analyzeCall(speechResult);

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

    console.log('Puhelu tallennettu Firestoreen.');
  } catch (error) {
    console.error('Puhelun analysointi/tallennus epäonnistui:', error);

    try {
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
    } catch (dbError) {
      console.error('Virheen tallennus Firestoreen epäonnistui:', dbError);
    }
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
