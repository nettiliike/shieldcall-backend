require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('AI Puhelinvastaaja backend toimii ✅');
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { language: 'fi-FI' },
    'Hei, tavoitit puhelinassistentin. Hän ei pääse juuri nyt vastaamaan. Kerro nimesi ja asiasi lyhyesti.'
  );

  twiml.pause({ length: 2 });

  twiml.say(
    { language: 'fi-FI' },
    'Kiitos, viesti on vastaanotettu. Mukavaa päivänjatkoa.'
  );

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`AI Puhelinvastaaja backend käynnissä portissa ${PORT}`);
});
