// Ops alert emails via the Resend HTTP API (https://resend.com — one POST,
// no SDK). Deliberately fire-and-forget: an alert failure must never break
// the scrape flow, so nothing in here throws.
//
// Configuration (all via env; nothing here is exposed to the dashboard):
//   RESEND_API_KEY    — Resend API key. Unset → alerts silently disabled.
//   ALERT_EMAIL       — recipient address. Unset → alerts silently disabled.
//                       Kept out of source and out of every API response on
//                       purpose; logs only ever show a masked form.
//   ALERT_EMAIL_FROM  — optional sender. Defaults to Resend's shared test
//                       sender, which works without domain verification.

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 30_000;

// "someone@example.com" → "s***@example.com" — safe for logs.
function maskEmail(addr) {
  const at = addr.indexOf('@');
  if (at <= 0) return '***';
  return `${addr[0]}***${addr.slice(at)}`;
}

async function sendAlertEmail(subject, textBody) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!apiKey || !to) {
    console.log('[notify] alert skipped — RESEND_API_KEY / ALERT_EMAIL not configured');
    return { sent: false, reason: 'not_configured' };
  }
  const from = process.env.ALERT_EMAIL_FROM || 'FB Ads Monitor <onboarding@resend.dev>';

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to: [to], subject, text: textBody }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[notify] Resend ${res.status}: ${errBody.slice(0, 300)}`);
      return { sent: false, reason: `resend_${res.status}` };
    }
    console.log(`[notify] alert emailed to ${maskEmail(to)}: ${subject}`);
    return { sent: true };
  } catch (err) {
    console.error('[notify] send failed:', err.message);
    return { sent: false, reason: 'send_error' };
  }
}

// Alert policy: only email when half or more of the batch failed — a single
// flaky target self-heals tomorrow and isn't worth an email.
function shouldAlert({ failed, total }) {
  return Number.isFinite(failed) && Number.isFinite(total) && total > 0
    && failed >= Math.ceil(total / 2);
}

// Called at the end of a scrape batch (server-side trigger-all loop, or the
// GitHub Actions workflows via POST /api/admin/alert-summary).
// `failedNames` is optional — the workflows only report counts.
async function alertScrapeSummary({ ok, failed, total, source, failedNames }) {
  if (!shouldAlert({ failed, total })) {
    return { sent: false, reason: 'below_threshold' };
  }
  const subject = `[FB Ads Monitor] ${failed}/${total} targets failed (${source})`;
  const lines = [
    `Scrape batch "${source}" finished with ${failed} of ${total} targets FAILED (${ok} OK).`,
    '',
  ];
  if (Array.isArray(failedNames) && failedNames.length) {
    lines.push('Failed targets:');
    for (const n of failedNames) lines.push(`  - ${n}`);
    lines.push('');
  }
  lines.push('Details: open the dashboard → Recent errors card.');
  lines.push(`Time (UTC): ${new Date().toISOString()}`);
  return sendAlertEmail(subject, lines.join('\n'));
}

module.exports = { sendAlertEmail, alertScrapeSummary, shouldAlert, maskEmail };
