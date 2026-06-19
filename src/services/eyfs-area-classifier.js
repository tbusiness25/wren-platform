'use strict';

// CL keywords exclude generic observation verbs (talked, said, asked, described) that
// appear in ALL area narratives. Only genuine language-development signals are kept.
// "conversation", "summarise", "word" retained as distinct CL/vocab signals.
const AREA_KEYWORDS = {
  'Communication and Language': [
    'vocabulary', 'sentence', 'sentences', 'conjunction', 'conjunctions',
    'conversation', 'summarise', 'summarised', 'word',
    'retold', 'retelling', 'narrate', 'narrated', 'narrative',
    'clarified', 'clarify', 'elaborated', 'elaborating', 'inference',
    'poem', 'poems', 'comprehension', 'phonological',
  ],
  'Personal, Social and Emotional Development': [
    'shared', 'sharing', 'comforted', 'emotion', 'emotion', 'feeling', 'feelings',
    'friend', 'friends', 'friendship', 'independent', 'independently',
    'settled', 'regulated', 'regulation', 'calm', 'upset', 'confident',
    'confidence', 'resilience', 'cooperate', 'cooperation', 'cooperatively',
    'waited', 'waiting', 'negotiated', 'negotiating', 'rules', 'behaviour',
    'behavior', 'hygiene', 'toilet', 'dressing', 'relationships', 'self-control',
    'impulse', 'persevere', 'perseverance', 'separation', 'attachment',
    'assigned', 'sensitivity', 'checking',
  ],
  'Physical Development': [
    'ran', 'running', 'climbed', 'climbing', 'jumped', 'jumping', 'balanced',
    'balancing', 'threw', 'throwing', 'catch', 'catching', 'pencil', 'grip',
    'scissors', 'coordination', 'outdoor', 'outside', 'dance', 'dancing',
    'skip', 'skipping', 'hop', 'hopping', 'crawl', 'crawling', 'strength',
    'dexterity', 'tripod', 'paintbrush', 'cutlery', 'obstacle', 'agility',
    'physical', 'movement', 'moved', 'moving', 'energetically',
  ],
  'Literacy': [
    'book', 'books', 'letter', 'letters', 'sound', 'sounds', 'phoneme', 'phonemes',
    'blending', 'segmenting', 'phonics', 'digraph', 'digraphs', 'decode', 'decoding',
    'reading', 'written', 'wrote', 'spell', 'spelling', 'word', 'words', 'text',
    'story', 'stories', 'rhyme', 'rhymes', 'anticipate', 'predicted', 'retell',
    'alphabet', 'initial', 'exception', 'decodable', 'sounded', 'recognisable',
    'mark', 'marks', 'writing', 'sounded',
  ],
  'Mathematics': [
    'counted', 'counting', 'count', 'number', 'numbers', 'more', 'less', 'fewer',
    'shape', 'shapes', 'pattern', 'patterns', 'size', 'weighed', 'measured',
    'sorted', 'sorting', 'compared', 'quantity', 'quantities', 'maths', 'math',
    'subitise', 'subitising', 'subitised', 'numeral', 'numerals', 'equal',
    'total', 'added', 'subtracted', 'double', 'ordinal', 'measurement',
    'weight', 'length', 'height', 'heavier', 'lighter', 'taller', 'shorter',
    'estimate', 'grapes', 'blocks', 'cubes', 'distributed', 'equally',
  ],
  'Understanding the World': [
    'nature', 'plant', 'plants', 'animal', 'animals', 'insect', 'insects',
    'weather', 'season', 'seasons', 'technology', 'family', 'community',
    'past', 'future', 'history', 'environment', 'culture', 'cultural',
    'religious', 'religion', 'festival', 'celebration', 'celebrations',
    'tradition', 'traditions', 'mosque', 'church', 'temple', 'synagogue',
    'christmas', 'diwali', 'eid', 'hanukkah', 'chinese',
    'world', 'country', 'countries', 'map', 'maps', 'geography', 'science',
    'observe', 'observed', 'investigation', 'minibeast', 'minibeasts',
    'habitat', 'change', 'grow', 'growing', 'woodlouse', 'similarities',
    'differences', 'people', 'celebrate', 'celebrating',
  ],
  'Expressive Arts and Design': [
    'painted', 'paint', 'painting', 'drew', 'draw', 'drew', 'sang', 'sing',
    'singing', 'danced', 'dance', 'dancing', 'instrument', 'music', 'musical',
    'junk', 'sculpture', 'colour', 'color', 'colours', 'mixing', 'art',
    'artistic', 'creative', 'create', 'craft', 'collage', 'perform',
    'performance', 'drama', 'character', 'costume', 'prop', 'props', 'clay',
    'texture', 'design', 'designed', 'modelling', 'foil', 'rocket',
    'song', 'rhyme', 'twinkle', 'macdonald',
  ],
};

// Multi-word phrases — matched as substrings, count +2
const AREA_PHRASES = {
  'Personal, Social and Emotional Development': [
    'took the lead', 'took turns', 'took turns', 'checked in with',
    'in the group', 'role-play corner', 'make friends',
  ],
  'Physical Development':       ['gross motor', 'fine motor', 'pencil grip', 'mark-making', 'balance beam', 'tripod grip'],
  'Expressive Arts and Design': ['junk model', 'junk modelling', 'colour mixing', 'role-playing'],
  'Understanding the World':    ['natural world', 'life cycle', 'local community', 'similarities and differences'],
  'Literacy':                   ['mark-making', 'sound blending', 'sound-blending', 'exception words', 'common exception'],
  'Mathematics':                ['number bonds', 'one-to-one', 'place value', 'number to'],
  'Communication and Language': ['back-and-forth', 'whole class', 'small group', 'recently introduced', 'introduced to'],
};

// Boundary chars — word ends at space, punctuation, or start/end of string
const BOUNDARY = /[\s,.'"\-:;!?()[\]]/;

/**
 * Classify an observation text into 1-2 EYFS areas.
 *
 * Returns { areas: string[]|null, confident: boolean }
 *   areas  — matched area names, or null if below confidence threshold
 *   confident — true when ≥2 keyword hits on top area
 */
function classifyArea(observationText) {
  const lower = (observationText || '').toLowerCase();
  const scores = {};

  for (const area of Object.keys(AREA_KEYWORDS)) scores[area] = 0;

  // Single-keyword matching with word-boundary check
  for (const [area, keywords] of Object.entries(AREA_KEYWORDS)) {
    for (const kw of keywords) {
      const idx = lower.indexOf(kw);
      if (idx !== -1) {
        const before = idx === 0 || BOUNDARY.test(lower[idx - 1]);
        const after  = idx + kw.length >= lower.length || BOUNDARY.test(lower[idx + kw.length]);
        if (before && after) scores[area]++;
      }
    }
  }

  // Phrase bonus (+2 each)
  for (const [area, phrases] of Object.entries(AREA_PHRASES)) {
    for (const phrase of phrases) {
      if (lower.includes(phrase)) scores[area] += 2;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const topScore = ranked[0][1];

  if (topScore < 2) return { areas: null, confident: false };

  // Include areas within 60% of top score (catches near-ties)
  const threshold = Math.max(topScore * 0.6, 2);
  const areas = ranked
    .filter(([, s]) => s >= threshold)
    .slice(0, 2)
    .map(([area]) => area);

  return { areas, confident: true };
}

module.exports = { classifyArea };
