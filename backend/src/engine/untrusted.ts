/**
 * Merchant-supplied text is untrusted. We only extract narrowly-typed product
 * facts from it with strict patterns, and separately flag anything that reads
 * like an instruction aimed at the agent or the payment system. Nothing in this
 * text can change a rule or a decision threshold.
 */

const INJECTION_PATTERNS: [RegExp, string][] = [
  [/\bignore\b[^.]{0,40}\b(previous|prior|above|earlier|spending|all)\b[^.]{0,30}\b(instructions?|rules?|limits?)/i, 'asks to ignore instructions or limits'],
  [/\b(system|assistant|developer|admin)\s*:/i, 'imitates a system/assistant message'],
  [/\bnote (for|to) (ai|automated|purchasing|shopping)?\s*(agents?|assistants?|bots?)\b/i, 'addresses the shopping agent directly'],
  [/\bautomated (purchasing|shopping)? ?agents?\b/i, 'addresses the shopping agent directly'],
  [/\bpre-?authori[sz]ed?\b/i, 'claims a pre-authorisation'],
  [/\blimits? (do|does|should) not apply\b/i, 'claims limits do not apply'],
  [/\bwithout (further |any )?(checks?|confirmation|verification|approval)\b/i, 'asks to skip checks'],
  [/\b(approve|authori[sz]e|accept)\b[^.]{0,20}\b(this|the)\b[^.]{0,15}\b(payment|order|purchase|transaction)\b[^.]{0,20}\b(immediately|now|automatically)?/i, 'tells the system to approve'],
  [/\b(cardholder|customer) is (unavailable|away|not available)\b/i, 'discourages asking the customer'],
  [/\b(do not|don't|no need to) (ask|notify|confirm|contact)\b/i, 'discourages asking the customer'],
];

export interface InjectionFinding { line_no: number; reason: string; excerpt: string }

export function detectInjection(lineNo: number, text: string): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  const seen = new Set<string>();
  for (const [re, reason] of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m && !seen.has(reason)) {
      seen.add(reason);
      const start = Math.max(0, m.index - 20);
      out.push({ line_no: lineNo, reason, excerpt: text.slice(start, Math.min(text.length, m.index + m[0].length + 20)).trim() });
    }
  }
  return out;
}

/** Only the first product-fact sentence(s) before any flagged instruction are trusted for facts. */
export interface ProductFacts { size?: string; returnDays?: number | null; noReturns?: boolean; returnUnstated?: boolean }

export function extractFacts(text: string): ProductFacts {
  const facts: ProductFacts = {};
  const size = text.match(/\bsize\s+([0-9]{2}(?:\.5)?|XXS|XS|S|M|L|XL|XXL)\b/i);
  if (size) facts.size = size[1].toUpperCase();
  const ret = text.match(/\breturns?\s+(?:accepted|possible|allowed)?\s*(?:within|for|up to)\s+(\d{1,3})\s+days?\b/i) ?? text.match(/\b(\d{1,3})[- ]day (?:free )?returns?\b/i);
  if (ret) facts.returnDays = Number(ret[1]);
  if (/\bfinal sale\b|\bno returns\b|\bnon-?returnable\b|\bcannot be returned\b/i.test(text)) { facts.noReturns = true; facts.returnDays = 0; }
  if (/\breturn policy not (stated|provided|specified)\b|\bno return (policy|information)\b/i.test(text)) facts.returnUnstated = true;
  return facts;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** A different merchant whose name is nearly identical to one the customer knows. */
export function isLookalike(candidate: string, known: string): boolean {
  const a = norm(candidate);
  const b = norm(known);
  if (a === b) return true;
  // Below 6 chars, edit distance 2 would match unrelated short names too often (e.g. "Coop"/"Coon").
  if (Math.min(a.length, b.length) < 6) return false;
  // Catches typo-squats like "Mlgros"/"Migros" without flagging genuinely different names.
  return levenshtein(a, b) <= 2;
}
