/**
 * Model-output validation helpers.
 */

/** Validate and normalize NER output into `{ [type]: string[] }`. */
export function normalizeEntityMap(data, { context = 'Model output' } = {}) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${context} did not return a JSON object`);
  }

  const normalized = {};
  for (const [rawKey, rawValues] of Object.entries(data)) {
    const key = String(rawKey).trim();
    if (!key) throw new Error(`${context} returned an empty entity type`);

    let source;
    if (typeof rawValues === 'string') source = [rawValues];
    else if (Array.isArray(rawValues)) source = rawValues;
    else throw new Error(`${context} returned an invalid value for entity type ${JSON.stringify(key)}`);

    const values = [];
    for (const rawValue of source) {
      const value = String(rawValue).trim();
      if (value && !values.includes(value)) values.push(value);
    }
    normalized[key] = values;
  }
  return normalized;
}
