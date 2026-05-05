require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const admin = require('firebase-admin');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COLLECTION = 'calls';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function initFirebase() {
  if (admin.apps.length) return;

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

initFirebase();
const db = admin.firestore();

function maskPhone(number = '') {
  if (!number) return 'Tuntematon';
  return number.replace(/(\+?\d{3,6})\d+(\d{2})$/, '$1*****$2');
}

async function isBlocked(number) {
  const doc = await db.collection('blocked_numbers').doc(number).get();
  return doc.exists;
}

async function isTrusted(number) {
  const doc = await db.collection('trusted_numbers').doc(number).get();
  return doc.exists;
}

// -------- DASHBOARD --------

app.get('/dashboard', async (req, res) => {
  const snapshot = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(50).get();

  const rows = snapshot.docs.map(doc => {
    const d = doc.data();
    const id = doc.id;

    return `
      <div style="background:#f3f4f6;padding:15px;margin-bottom:15px;border-radius:10px;">
        <p><b>${d.summary || ''}</b></p>
        <p>${d.from}</p>

        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <a href="tel:${d.from}" style="background:#2563eb;color:white;padding:8px 12px;border-radius:6px;">Soita takaisin</a>

          <form method="POST" action="/call/${id}/done">
            <button>Hoidettu</button>
          </form>

          <form method="POST" action="/call/${id}/block">
            <button style="background:red;color:white;">Estä</button>
          </form>

          <form method="POST" action="/call/${id}/trust">
            <button style="background:orange;color:white;">Luotettu</button>
          </form>
        </div>
      </div>
    `;
  }).join('');

  res.send(`<h1>Dashboard</h1>${rows}`);
});

// -------- ACTIONS --------

app.post('/call/:id/done', async (req, res) => {
  await db.collection(COLLECTION).doc(req.params.id).update({ status: 'done' });
  res.redirect('/dashboard');
});

app.post('/call/:id/block', async (req, res) => {
  const doc = await db.collection(COLLECTION).doc(req.params.id).get();
  const data = doc.data();

  await db.collection('blocked_numbers').doc(data.from).set({
    number: data.from,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.redirect('/dashboard');
});

app.post('/call/:id/trust', async (req, res) => {
  const doc = await db.collection(COLLECTION).doc(req.params.id).get();
  const data = doc.data();

  await db.collection('trusted_numbers').doc(data.from).set({
    number: data.from,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  res.redirect('/dashboard');
});

// -------- VOICE --------

app.post('/voice', async (req, res) => {
  const caller = req.body.From;
  const twiml = new twilio.twiml.VoiceResponse();

  // BLOCKED → katkaise heti
  if (await isBlocked(caller)) {
    twiml.say({ language: 'fi-FI' }, 'Puhelua ei voida yhdistää.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // TRUSTED → yhdistä suoraan
  if (await isTrusted(caller)) {
    twiml.say({ language: 'fi-FI' }, 'Yhdistetään.');
    twiml.dial(process.env.FORWARD_TO_NUMBER);
    return res.type('text/xml').send(twiml.toString());
  }

  // AI vastaaja
  const gather = twiml.gather({
    input: 'speech',
    language: 'fi-FI',
    action: '/voice/process',
    method: 'POST',
    timeout: 5,
    maxSpeechTime: 30,
  });

  gather.say(
    { language: 'fi-FI' },
    'Hei, olen Mikon puhelinassistentti. Hän ei pääse nyt vastaamaan. Kerro nimesi ja asiasi.'
  );

  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/process', async (req, res) => {
  const speech = req.body.SpeechResult || '';
  const caller = req.body.From;

  await db.collection(COLLECTION).add({
    from: caller,
    summary: speech,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ language: 'fi-FI' }, 'Kiitos, viesti tallennettu.');
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

app.listen(PORT, () => {
  console.log('Server running');
});
