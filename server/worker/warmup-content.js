'use strict';

// Natural, varied Lithuanian warmup messages built from random combinations.
// Rules: no links, no images, no tracking, no unsubscribe footer, no sales
// language. Every message carries a 6-char code in the body text so seeds and
// mailboxes can recognise it (codes are never put in headers or subjects).

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

function pickN(arr, n) {
  const copy = arr.slice();
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

// No 0/O/1/I to keep codes unambiguous
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (/[0-9]/.test(c) && /[A-Z]/.test(c)) return c; // mixed → never a real word
  }
}

// Candidate codes in a body (verified against the DB by the caller)
function findCodes(text) {
  return [...new Set(String(text || '').match(/\b[A-HJ-NP-Z2-9]{6}\b/g) || [])]
    .filter(c => /[0-9]/.test(c) && /[A-Z]/.test(c));
}

const GREETINGS = ['Labas', 'Sveiki', 'Laba diena', 'Labas!', 'Sveikas', 'Labas dar kartą', 'Sveiki,'];

const TOPICS = {
  question: {
    subjects: ['Greitas klausimas', 'Klausimas dėl rytojaus', 'Dėl kitos savaitės', 'Ar turi minutę?', 'Klausimėlis',
      'Dėl dokumentų', 'Pasitikslinu', 'Dėl ketvirtadienio', 'Vienas klausimas', 'Dėl vakarykščio'],
    lines: [
      'Ar spėsi peržiūrėti mano vakar siųstas pastabas iki penktadienio?',
      'Gal žinai, kur dabar laikome naujausią dokumentų versiją?',
      'Ar dar galioja tas laikas, kurį aptarėme praėjusią savaitę?',
      'Norėjau pasitikslinti, ar viską gavai.',
      'Ar galėtum priminti, kas atsakingas už šią dalį?',
      'Ar tau patogiau susirašinėti čia, ar paskambinti?',
      'Gal turi minutę šiandien po pietų?',
      'Ar jau aišku, kada bus galutinis sprendimas?',
      'Ar tiktų, jei parengčiau trumpą santrauką?',
      'Ar reikia dar ko nors iš mano pusės?',
      'Ar pavyko atidaryti failą, kurį siunčiau?',
      'Ar planas vis dar toks pat, ar kažkas keitėsi?',
    ],
  },
  notes: {
    subjects: ['Susitikimo užrašai', 'Trumpai po pokalbio', 'Užrašai iš šiandienos', 'Ką sutarėme', 'Santrauka',
      'Po vakarykščio skambučio', 'Keli užrašai', 'Trumpa santrauka'],
    lines: [
      'Trumpai užsirašiau, ką aptarėme.',
      'Sutarėme, kad kitą žingsnį darysime po savaitės.',
      'Pirmą dalį pabaigiau, antrą pradėsiu rytoj.',
      'Pagrindiniai klausimai lieka tie patys, tik terminas šiek tiek pasislinko.',
      'Užrašus susidėjau į bendrą aplanką.',
      'Liko suderinti tik keletą smulkmenų.',
      'Visi sutiko, kad dabartinis planas tinka.',
      'Kitą kartą pradėsime nuo to, kur baigėme šiandien.',
      'Atsakingus asmenis pažymėjau prie kiekvieno punkto.',
      'Jei ką praleidau, papildyk.',
    ],
  },
  thanks: {
    subjects: ['Ačiū', 'Dėkoju', 'Ačiū už pagalbą', 'Labai ačiū', 'Ačiū už vakar', 'Dėkui'],
    lines: [
      'Ačiū, kad taip greitai atsakei.',
      'Labai ačiū už vakarykštę pagalbą.',
      'Dėkoju už kantrybę.',
      'Ačiū už pastabas, jos labai pravertė.',
      'Ačiū, kad radai laiko.',
      'Dėkui, dabar viskas veikia.',
      'Ačiū už priminimą, visai buvo išslydę iš galvos.',
      'Labai vertinu, kad padėjai.',
    ],
  },
  scheduling: {
    subjects: ['Laikas susitikimui', 'Ar tinka antradienis?', 'Dėl susitikimo laiko', 'Perkeliam?', 'Kada patogu?',
      'Skambutis kitą savaitę', 'Dėl pokalbio', 'Susitikimas'],
    lines: [
      'Ar tau tiktų antradienį apie dešimtą?',
      'Galėčiau ketvirtadienį po pietų, jei tau patogu.',
      'Gal galime perkelti pokalbį į kitą savaitę?',
      'Man tinka bet kuri diena, išskyrus pirmadienį.',
      'Siūlau susitikti trumpam, gal pusvalandžiui.',
      'Rytoj nuo pietų turėsiu laiko.',
      'Parašyk, koks laikas tau patogiausias.',
      'Jei netinka, galime susiderinti kitą laiką.',
      'Penktadienio rytas man būtų idealus.',
    ],
  },
};

const FILLERS = [
  'Šiandien diena gana įtempta, bet viskas juda į priekį.',
  'Pas mus viskas gerai.',
  'Savaitė prabėgo labai greitai.',
  'Tikiuosi, kad tau viskas sekasi gerai.',
  'Oras šiandien pagaliau geresnis.',
  'Jei kas, rašyk.',
  'Neskubu, atsakyk kai turėsi laiko.',
  'Ryte buvo daug darbų, tai rašau tik dabar.',
];

const CLOSINGS = ['Gražios dienos!', 'Iki!', 'Geros savaitės!', 'Ačiū!', 'Iki greito.', 'Linkėjimai,', 'Gero vakaro!', 'Sėkmės!'];

const REPLIES = [
  'Ačiū, gavau.', 'Puiku, ačiū!', 'Taip, man tinka.', 'Sutarta.', 'Peržiūrėsiu ir parašysiu rytoj.',
  'Gerai, ačiū už informaciją.', 'Supratau, ačiū.', 'Taip, viską gavau.', 'Tinka, iki tada.',
  'Ačiū, labai pravers.', 'Puiku, tada taip ir darom.', 'Gerai, pasižymėjau kalendoriuje.',
  'Ačiū, kad parašei.', 'Aišku, ačiū!', 'Taip, tinka. Iki!', 'Gavau, pažiūrėsiu po pietų.',
];
const REPLY_EXTRAS = ['Jei kas pasikeis, parašysiu.', 'Gražios dienos.', 'Iki!', 'Iki greito.', 'Geros savaitės.'];
const CONTINUATIONS = ['Puiku, ačiū!', 'Super, iki tada.', 'Ačiū, sutarta.', 'Gerai, tada laukiu.', 'Ačiū už greitą atsakymą.', 'Puiku, viskas aišku.'];

function signatureName(email, displayName) {
  const first = String(displayName || '').trim().split(/\s+/)[0];
  if (first) return first;
  const local = String(email || '').split('@')[0].split(/[._-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : '';
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// paragraphs: array of strings (lines within a paragraph joined by \n)
function render(paragraphs, code) {
  const text = paragraphs.join('\n\n') + `\n\n${code}`;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">' +
    paragraphs.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('') +
    `<p>${code}</p></div>`;
  return { text, html };
}

// New thread from a mailbox to a seed
function newMessage({ fromEmail, fromName }) {
  const topic = TOPICS[pick(Object.keys(TOPICS))];
  const code = makeCode();
  const body = pickN(topic.lines, chance(0.5) ? 1 : 2);
  if (chance(0.4)) body.splice(Math.floor(Math.random() * (body.length + 1)), 0, pick(FILLERS));
  const paragraphs = [`${pick(GREETINGS).replace(/[,!]$/, '')},`, body.join(' ')];
  const sig = signatureName(fromEmail, fromName);
  paragraphs.push(sig ? `${pick(CLOSINGS)}\n${sig}` : pick(CLOSINGS));
  return { subject: pick(topic.subjects), code, ...render(paragraphs, code) };
}

// Short reply (seed → mailbox, or mailbox continuing the thread)
function replyMessage({ fromEmail, fromName, continuation = false }) {
  const code = makeCode();
  const first = continuation ? pick(CONTINUATIONS) : pick(REPLIES);
  const parts = [first];
  if (!continuation && chance(0.45)) parts.push(pick(REPLY_EXTRAS));
  const paragraphs = [parts.join(' ')];
  const sig = signatureName(fromEmail, fromName);
  if (sig && chance(0.7)) paragraphs.push(sig);
  return { code, ...render(paragraphs, code) };
}

function replySubject(subject) {
  return 'Re: ' + String(subject || '').replace(/^\s*(re:\s*)+/i, '');
}

module.exports = { newMessage, replyMessage, replySubject, makeCode, findCodes };
