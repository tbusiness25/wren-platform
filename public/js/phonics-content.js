/* Wren Phonics — shared display helpers (b157)
 * Phase 1 ("Introduction") is measured in listening ASPECTS, not letter sounds — the DB
 * stores them as sound_type='phase1_aspect' with an underscore-joined code
 * (e.g. environmental_sounds). Rendering that code as a letter-tile abbreviation
 * ("es", "bp", "rar"...) is the b157 display bug — always resolve through
 * WrenPhonics.aspectLabel()/aspectInfo() instead of deriving text from the code.
 */
(function (global) {
  'use strict';

  var ASPECTS = {
    environmental_sounds: {
      name: 'Listening Walk', emoji: '🌳',
      short: 'Environmental sounds',
      description: 'Sounds all around us — traffic, wind, birds, doors closing. Noticing and naming what we hear, indoors and out.'
    },
    instrumental_sounds: {
      name: 'Instrument Sounds', emoji: '🥁',
      short: 'Instrumental sounds',
      description: 'Sounds made with instruments — drums, bells, tambourines, shakers. Telling different instruments apart by ear alone.'
    },
    body_percussion: {
      name: 'Body Percussion', emoji: '👏',
      short: 'Body percussion',
      description: 'Sounds made with our own bodies — clapping, stamping, clicking fingers. Copying and making simple rhythm patterns.'
    },
    rhythm_and_rhyme: {
      name: 'Rhythm & Rhyme', emoji: '🎶',
      short: 'Rhythm and rhyme',
      description: 'Nursery rhymes, songs and rhyming words — feeling the beat and spotting words that rhyme with each other.'
    },
    alliteration: {
      name: 'Alliteration', emoji: '👄',
      short: 'Alliteration',
      description: 'Words that start with the same sound, like "Silly Sally sings" — hearing the sound at the start of a word.'
    },
    voice_sounds: {
      name: 'Voice Sounds', emoji: '🗣️',
      short: 'Voice sounds',
      description: 'Exploring what our voices can do — loud and quiet, high and low, long and short sounds.'
    },
    oral_blending: {
      name: 'Oral Blending & Segmenting', emoji: '🧩',
      short: 'Oral blending',
      description: 'Pulling sounds together to say a word (c-a-t → cat) and breaking a word back apart into its sounds.'
    }
  };

  function aspectInfo(code) { return ASPECTS[code] || null; }
  function aspectLabel(code) { var a = ASPECTS[code]; return a ? a.name : code; }
  function isAspect(soundType) { return soundType === 'phase1_aspect'; }

  global.WrenPhonics = global.WrenPhonics || {};
  global.WrenPhonics.ASPECTS = ASPECTS;
  global.WrenPhonics.aspectInfo = aspectInfo;
  global.WrenPhonics.aspectLabel = aspectLabel;
  global.WrenPhonics.isAspect = isAspect;
})(window);
