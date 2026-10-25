// api/_lib/beta.js
// BETA_UNLIMITED_UNTIL (ISO date, e.g. 2026-12-01) is the kill switch for unlimited access. Unset or past = closed.
// Evaluated on every request, so changing the env var (and redeploying) ends or extends the beta without a client update.
export function betaUntil() {
  const t = Date.parse(process.env.BETA_UNLIMITED_UNTIL || '');
  return Number.isFinite(t) ? t : 0;
}

export function betaOpen() {
  return Date.now() < betaUntil();
}
