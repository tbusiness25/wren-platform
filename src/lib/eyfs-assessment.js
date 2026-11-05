'use strict';
// ═════════════════════════════════════════════════════════════════════════════
// b213 — EYFS knowledge questions for Level 2 / Level 3 job applicants.
//
// Ten short WRITTEN questions a qualified practitioner should be able to answer
// in their own words. They exist so that a manager can see two things before
// spending time on an interview: whether the person can write clearly, and
// whether the subject knowledge behind the certificate is really there.
//
// ⚠️  DELIBERATELY NOT SCORED. There is no mark scheme, no model answer, no AI
//     grading and no auto-reject anywhere in this codebase. A person applying
//     for a job is entitled to have another person read what they wrote. The
//     only job of this module is to ask the questions and keep the answers
//     tidy so a human can read them next to the CV.
//
// Single source of truth: served to the public careers page over
// GET /api/public/careers/assessment, and used server-side to attach the
// canonical question text to whatever the applicant typed (so the stored
// record still makes sense years later, even if the wording here changes).
// ═════════════════════════════════════════════════════════════════════════════

// Bump when the wording of the questions changes materially. Stored on each
// submission so old answers stay readable against the questions actually asked.
const ASSESSMENT_VERSION = 1;

// Qualification options offered on the application form.
// `assess: true` → the EYFS questions are asked.
const QUALIFICATIONS = [
  { value: 'none',     label: 'None yet / working towards one', assess: false },
  { value: 'level_2',  label: 'Level 2 (e.g. NVQ/CACHE Level 2)', assess: true  },
  { value: 'level_3',  label: 'Level 3 (e.g. NVQ/CACHE/BTEC Level 3)', assess: true  },
  { value: 'level_4',  label: 'Level 4 or above (Level 4/5/6, Foundation Degree)', assess: false },
  { value: 'eyt_qts',  label: 'Early Years Teacher (EYT) or QTS', assess: false },
  { value: 'other',    label: 'Other', assess: false },
];

const QUALIFICATION_VALUES = QUALIFICATIONS.map(q => q.value);

// The ten questions. `hint` is shown small under the box — it steers the answer
// without giving it away, so nobody is guessing at what we're asking for.
const QUESTIONS = [
  {
    id: 'ratios',
    topic: 'Ratios',
    prompt: 'What are the required adult-to-child ratios in an early years setting, and what would you do if your room was about to fall below ratio?',
    hint: 'Cover the different age groups, and the practical step you would take in the moment.',
  },
  {
    id: 'safeguarding',
    topic: 'Safeguarding',
    prompt: 'A child arrives with a bruise and says something that worries you. Walk us through exactly what you would do, and in what order.',
    hint: 'Who you tell, what you record, what you do not do, and how quickly.',
  },
  {
    id: 'prime_areas',
    topic: 'The prime areas',
    prompt: 'Name the three prime areas of learning in the EYFS and explain why they are called "prime".',
    hint: 'What makes them different from the specific areas?',
  },
  {
    id: 'next_steps',
    topic: 'Next steps',
    prompt: 'You have just observed a two-year-old stacking and knocking down blocks over and over. What next step would you plan for them, and why that one?',
    hint: 'We are interested in your reasoning, not a perfect answer.',
  },
  {
    id: 'key_person',
    topic: 'The key person',
    prompt: 'What is the key person role, and what does it look like day to day for a child who is new and finding settling hard?',
    hint: 'Think about the child, and about the relationship with their family.',
  },
  {
    id: 'play',
    topic: 'Learning through play',
    prompt: 'How do children learn through play? Give one real example of something a child learned through play that you have seen yourself.',
    hint: 'A specific memory tells us far more than a definition.',
  },
  {
    id: 'two_year_check',
    topic: 'The progress check at age two',
    prompt: 'What is the progress check at age two, who is it shared with, and what would you include in it?',
    hint: 'Purpose, audience, and what actually goes in the write-up.',
  },
  {
    id: 'schemas',
    topic: 'Schemas',
    prompt: 'What is a schema in early years practice? Describe one you have noticed in a child and how you supported it.',
    hint: 'For example transporting, enveloping, rotation, trajectory.',
  },
  {
    id: 'eyfs_changes',
    topic: 'Keeping up to date',
    prompt: 'What changes to the EYFS framework are you aware of, and how have they changed what practitioners actually do?',
    hint: 'Tell us honestly what you know — we would rather that than guesswork.',
  },
  {
    id: 'speech_language',
    topic: 'Speech and language',
    prompt: 'How would you support a three-year-old whose speech is behind that of their peers? What would you do in the room, and who else would you involve?',
    hint: 'Everyday strategies, and when you would raise it with someone else.',
  },
];

const QUESTION_BY_ID = QUESTIONS.reduce((m, q) => { m[q.id] = q; return m; }, {});

// Answer sanity limits — generous enough for a thoughtful answer, tight enough
// that nobody can paste a novel into the database.
const MIN_ANSWER_CHARS = 15;
const MAX_ANSWER_CHARS = 2500;

/** Does this qualification trigger the EYFS questions? */
function needsAssessment(qualification) {
  const q = QUALIFICATIONS.find(x => x.value === qualification);
  return !!(q && q.assess);
}

/** Public shape for the careers page (no answers, obviously). */
function publicAssessment() {
  return {
    version: ASSESSMENT_VERSION,
    min_answer_chars: MIN_ANSWER_CHARS,
    max_answer_chars: MAX_ANSWER_CHARS,
    qualifications: QUALIFICATIONS.map(q => ({ value: q.value, label: q.label, assess: q.assess })),
    questions: QUESTIONS.map(q => ({ id: q.id, topic: q.topic, prompt: q.prompt, hint: q.hint })),
  };
}

/**
 * Take whatever the applicant submitted and turn it into the stored record.
 * Input: array of {id, answer} (or an {id: answer} object).
 *
 * Returns { ok: true, assessment } or { ok: false, error } — the error is shown
 * to the applicant, so it must be plain and kind.
 *
 * Every question is attached with its canonical prompt text, in the canonical
 * order, so the manager reads Q and A together and unanswered ones are visible
 * rather than silently missing.
 */
function buildAssessment(raw, qualification) {
  let given = {};
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (a && a.id != null) given[String(a.id)] = a.answer;
    }
  } else if (raw && typeof raw === 'object') {
    given = raw;
  } else {
    return { ok: false, error: 'We could not read your answers. Please try again.' };
  }

  const answers = [];
  const missing = [];
  for (const q of QUESTIONS) {
    let text = given[q.id];
    text = text == null ? '' : String(text).replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_ANSWER_CHARS) text = text.slice(0, MAX_ANSWER_CHARS);
    if (text.length < MIN_ANSWER_CHARS) missing.push(q.topic);
    answers.push({ id: q.id, topic: q.topic, prompt: q.prompt, answer: text });
  }

  if (missing.length) {
    return {
      ok: false,
      error: missing.length === QUESTIONS.length
        ? 'Please answer the ten EYFS questions in your own words before sending your application.'
        : `Please add a little more to: ${missing.join(', ')}.`,
    };
  }

  return {
    ok: true,
    assessment: {
      version: ASSESSMENT_VERSION,
      qualification: qualification || null,
      // Not scored — see the header of this file.
      scored: false,
      answers,
    },
  };
}

module.exports = {
  ASSESSMENT_VERSION,
  QUALIFICATIONS,
  QUALIFICATION_VALUES,
  QUESTIONS,
  QUESTION_BY_ID,
  MIN_ANSWER_CHARS,
  MAX_ANSWER_CHARS,
  needsAssessment,
  publicAssessment,
  buildAssessment,
};
