// Someone's own words, quoted inside a sentence of ours in a notification:
//
//   they wrote  Need the invoice    →  ... missing. "Need the invoice". The approval waits ...
//   they wrote  Need the invoice.   →  ... missing. "Need the invoice." The approval waits ...
//
// The quote ends the sentence, so it carries the full stop, unless the words
// already end one (. ! ? …, optionally before a closing quote or bracket). The
// copy used to append the stop unconditionally, which read `"…line 3.".`.

const ENDS_A_SENTENCE = /[.!?…]["'”’)\]]*$/;

/**
 * ` "text".` (leading space included), ` "text"` when the text already ends a
 * sentence, or "" when there is nothing to quote. Surrounding whitespace is
 * trimmed; nothing else in the text changes.
 * @param {*} text
 * @returns {string}
 */
export function quoteInSentence(text) {
  const t = text == null ? "" : String(text).trim();
  if (!t) return "";
  return ENDS_A_SENTENCE.test(t) ? ` "${t}"` : ` "${t}".`;
}
