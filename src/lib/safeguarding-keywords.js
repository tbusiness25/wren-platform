'use strict';
/**
 * safeguarding-keywords.js — b487 (2026-10-12)
 *
 * The safeguarding phrase-match pattern, lifted out of src/routes/ai.js (where
 * it was a private top-level const used for the parent-chat safeguarding
 * redirect) so src/lib/inbox-hermes.js and the inbox permission filter can use
 * the exact same pattern rather than a second copy that could drift from it.
 * ai.js now requires this instead of declaring its own SAFEGUARD_RE.
 */
// b486c (2026-10-13, CHECK.md defect 10): four of the original bare-word
// alternatives were wide enough to catch ordinary nursery business mail —
// confirmed on the review harness's fixtures:
//   - `harm\w*`        matched "Harmony" (a child's/company's name) — \w* after
//                       the literal "harm" happily consumes "ony".
//   - `hurt\w*`        matched "hurt our cashflow this month" in a finance email.
//   - `disclos\w*`     matched "disclose a payment" / a GDPR data-disclosure line.
//   - `unexplained`    (bare) matched "an unexplained charge on the statement".
// review 2026-10-13: the noun 'disclosure' and 'disclosed that/to/about' are put back — they are the
// phrases a child's disclosure arrives in ("she made a disclosure", "she disclosed that…"), and the
// narrowing had dropped them; the billing false positive was the VERB 'disclose' ("disclose the
// funding breakdown"), which stays out.
// Narrowed below so each of those four still fires for a genuine safeguarding
// use (see scripts/b486c-safeguard-regex-test.js for the pass/fail list this
// was checked against — bruise, injury, "hurt by", "disclosure of harm" etc.
// must still match) but not the billing/identity false positives.
const SAFEGUARD_RE = /\b(safeguard\w*|disclosure\w*|disclosed\s+(?:that|to|about)|disclos\w*\s+(?:of\s+)?(?:abuse|harm|neglect)|abus\w*|neglect\w*|bruis\w*|injur\w*|a mark|marks on|flinch\w*|harm(?!on)\w*|hurt\w*\s+(?:by|me|him|her|them|us)\b|hitting|smack\w*|inappropriate touch\w*|touched (her|him|me|them)|grooming|cse|fgm|radicali[sz]\w*|prevent duty|self.?harm\w*|domestic (abuse|violence)|welfare concern|child protection|unexplained\s+(?:bruis\w*|injur\w*|marks?|absences?)|something(?:'s| is)? not right|worried about (a|the|this|my key) child|concerned about a child)\b/i;

// review 2026-10-13: the ORIGINAL, deliberately broad pattern (byte-for-byte what ai.js carried
// before b487). The narrowing above is right for the Inbox — a billing email must not lose its
// invoice facts because it says "unexplained charge" — but ai.js uses the same pattern as a hard
// redirect-to-the-DSL guard on the parent chat and the EYFS practice chat, where a false positive
// costs one redirect and a false negative ("he got hurt at nursery", "she made a disclosure")
// costs a missed safeguarding worry. ai.js therefore keeps this one.
const SAFEGUARD_RE_BROAD = /\b(safeguard\w*|disclos\w*|abus\w*|neglect\w*|bruis\w*|injur\w*|a mark|marks on|flinch\w*|harm\w*|hurt\w*|hitting|smack\w*|inappropriate touch\w*|touched (her|him|me|them)|grooming|cse|fgm|radicali[sz]\w*|prevent duty|self.?harm\w*|domestic (abuse|violence)|welfare concern|child protection|unexplained|something(?:'s| is)? not right|worried about (a|the|this|my key) child|concerned about a child)\b/i;

module.exports = { SAFEGUARD_RE, SAFEGUARD_RE_BROAD };
