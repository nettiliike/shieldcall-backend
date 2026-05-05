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
Olet suomalaisen AI-puhelinvastaajan erittäin varovainen huijaus- ja riskianalyysimoottori.

Analysoi tämä puhelinvastaajaan jätetty viesti:

"${speechResult}"

TÄRKEÄT RISKISÄÄNNÖT:

1. Jos soittaja väittää olevansa pankista, poliisista, viranomaiselta, verottajalta, Kelasta, tullista, operaattorilta tai turvallisuusosastolta, älä luokittele suoraan turvalliseksi.
2. Jos viestissä mainitaan pankki, tili, kortti, verkkopankki, tunnusluvut, vahvistus, tunnistautuminen, epäilyttävä tapahtuma, rahansiirto, maksu, kortin sulkeminen tai kiireellinen turvallisuusasia, nosta riskiä selvästi.
3. Jos soittaja pyytää takaisinsoittoa pankki-, poliisi- tai viranomaisasiassa, suosittele tarkistamaan asia virallista numeroa käyttäen, ei suoraan soittajan numeroon.
4. Jos viestissä on kiire, uhka, painostus, “tili suljetaan”, “rahat vaarassa”, “epäilyttävä tapahtuma”, “vahvista heti” tai vastaavaa, riski on korkea.
5. Pankki- ja poliisipuheluissa riski ei saa olla alle 60, ellei viesti ole täysin harmiton ja yksilöity ilman raha-, tili-, kortti-, turvallisuus- tai tunnistautumisviitteitä.
6. Jos viesti on tavallinen ajanvaraus, toimitus, asiakaspalvelu tai tuttavan yhteydenotto ilman riskisanoja, riski voi olla matala.
7. Älä anna varmaa väitettä, että kyseessä on huijaus, ellei sisältö ole selvästi huijaava. Käytä varovaista arviointia.

Palauta VAIN validi JSON tässä muodossa:
{
  "callerName": "soittajan nimi jos ilmenee, muuten Tuntematon",
  "summary": "lyhyt 1-2 virkkeen yhteenveto",
  "category": "tärkeä | normaali | myynti | huijaus | epäselvä",
  "priority": "korkea | keskitaso | matala",
  "recommendedAction": "soita takaisin heti | soita takaisin myöhemmin | ei vaadi toimenpidettä | tarkista virallisesta numerosta ennen takaisinsoittoa | älä soita takaisin ennen tarkistusta",
  "spamRisk": 0,
  "riskReason": "lyhyt selitys miksi riski on tämä"
}

Esimerkkejä:
- "Soitan pankista, tililläsi on epäilyttävää toimintaa" -> spamRisk 80-95, category "huijaus" tai "epäselvä", recommendedAction "tarkista virallisesta numerosta ennen takaisinsoittoa"
- "Tässä poliisi, soita takaisin kiireesti" -> spamRisk 70-90
- "Hei, olen Matti ja huominen tapaaminen klo 11 vielä voimassa?" -> spamRisk 0-15
- "Tarjoan sähkösopimusta" -> spamRisk 30-60, category "myynti"
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
    riskReason: 'AI ei palauttanut kelvollista analyysiä.',
  };
}

function formatDate(value) {
  if (!value) return '';
  if (value.toDate) return value.toDate().toLocaleString('fi-FI');
  return String(value);
}

function riskClass(risk) {
  if (risk >= 70) return 'high-risk';
  if (risk >= 35) return 'medium-risk';
  return 'low-risk';
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

    const rows = snapshot.docs
      .map((doc) => {
        const d = doc.data();
        const risk = Number(d.spamRisk || 0);
        const cardClass = d.type === 'ai_voicemail_error' ? 'error' : riskClass(risk);

        return `
          <div class="card ${cardClass}">
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
            <p><b>Riskin syy:</b> ${d.riskReason || '-'}</p>
            <p><b>Puheen sisältö:</b> ${d.transcript || '-'}</p>
            ${d.error ? `<p class="err"><b>Virhe:</b> ${d.error}</p>` : ''}
          </div>
        `;
      })
      .join('');

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

          .actions {
            text-align: center;
            margin: 20px;
          }

          button {
            border: none;
            background: #ef4444;
            color: white;
            padding: 12px 18px;
            border-radius: 999px;
            font-weight: bold;
            cursor: pointer;
          }

          button:hover {
            opacity: 0.9;
          }

          .card {
            border-radius: 18px;
            padding: 22px;
            margin-bottom: 18px;
            box-shadow: 0 8px 20px rgba(0,0,0,0.18);
          }

          .low-risk {
            background: #dcfce7;
          }

          .medium-risk {
            background: #fef3c7;
          }

          .high-risk {
            background: #fee2e2;
            border: 2px solid #dc2626;
          }

          .error {
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
            text-transform: capitalize;
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

          .medium-risk .risk {
            background: #f59e0b;
          }

          .high-risk .risk {
            background: #dc2626;
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

        <div class="actions">
          <form method="POST" action="/dashboard/clear">
            <button type="submit" onclick="return confirm('Haluatko varmasti pyyhkiä logit?')">
              Pyyhi logi
            </button>
          </form>
        </div>

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
    timeout: 5,
    action: '/voice/process',
    method: 'POST',
    maxSpeechTime: 30,
  });

  gather.say(
    { language: 'fi-FI' },
    'Hei, olen Mikon puhelinassistentti. Hän ei juuri nyt pääse vastaamaan. Kerro nimesi ja asiasi lyhyesti, niin hän palaa asiaan.'
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
      riskReason: analysis.riskReason || '',
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
      riskReason: 'Analyysi epäonnistui teknisen virheen takia.',
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

app.post('/dashboard/clear', async (req, res) => {
  try {
    const snapshot = await db.collection(COLLECTION).limit(100).get();

    const batch = db.batch();

    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();

    res.redirect('/dashboard');
  } catch (error) {
    console.error('Logien poisto epäonnistui:', error);
    res.status(500).send('Logien poisto epäonnistui: ' + error.message);
  }
});

app.listen(PORT, () => {
  console.log(`AI Puhelinvastaaja backend käynnissä portissa ${PORT}`);
});
