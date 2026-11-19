/**
 * Prompt builders for the HaS text model's six atomic capabilities.
 *
 * CRITICAL: these templates must match the model's training templates
 * character for character. Do not "tidy" the spacing or punctuation.
 */

function compactJson(value) {
  return JSON.stringify(value);
}

function typesJson(types) {
  return compactJson(types);
}

/** NER: single turn. */
export function buildNerMessages(text, types) {
  const content =
    'Recognize the following entity types in the text.\n' +
    `Specified types:${typesJson(types)}\n` +
    `<text>${text}</text>`;
  return [{ role: 'user', content }];
}

/** Hide without an existing mapping: user / assistant(ner) / user. */
export function buildHideWithoutMessages(text, types, nerResult) {
  const first =
    'Recognize the following entity types in the text.\n' +
    `Specified types:${typesJson(types)}\n` +
    `<text>${text}</text>`;
  return [
    { role: 'user', content: first },
    { role: 'assistant', content: nerResult },
    { role: 'user', content: 'Replace the above-mentioned entity types in the text.' },
  ];
}

/** Hide with an existing mapping: user / assistant(ner) / user(+mapping). */
export function buildHideWithMessages(text, types, nerResult, mapping) {
  const first =
    'Recognize the following entity types in the text.\n' +
    `Specified types:${typesJson(types)}\n` +
    `<text>${text}</text>`;
  const second =
    'Replace the above-mentioned entity types in the text ' +
    `according to the existing mapping pairs:${compactJson(mapping)}`;
  return [
    { role: 'user', content: first },
    { role: 'assistant', content: nerResult },
    { role: 'user', content: second },
  ];
}

/** Pair: extract a mapping from an original/anonymized pair. */
export function buildPairMessages(originalText, anonymizedText) {
  const content =
    `<original>${originalText}</original>\n` +
    `<anonymized>${anonymizedText}</anonymized>\n` +
    'Extract the mapping from anonymized entities to original entities.';
  return [{ role: 'user', content }];
}

/** Split: split composite anonymized keys into atomic keys. */
export function buildSplitMessages(compositeMapping) {
  const content =
    'Split each composite anonymized key into atomic keys.\n' +
    'Composite mapping:\n' +
    compactJson(compositeMapping);
  return [{ role: 'user', content }];
}

/** Seek: restore an anonymized text from a mapping. */
export function buildSeekMessages(mapping, textWithTags) {
  const content =
    'The mapping from anonymized entities to original entities:\n' +
    `${compactJson(mapping)}\n` +
    'Restore the original text based on the above mapping:\n' +
    `${textWithTags}`;
  return [{ role: 'user', content }];
}
