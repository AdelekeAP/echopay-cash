// EchoPay Cash admin dashboard — polls /admin/state, surfaces wallet +
// credit score per persona, runs reconcile on demand. Vanilla JS, no
// framework, no build step. Serve via `python -m http.server 5173` from
// the admin/ dir per PRD_LEKE §5.

(() => {
  // ---- config ----------------------------------------------------------------

  // Backend URL: respect ?api=<url>, else default to localhost:8100.
  // CORS is handled by FastAPI's CORSMiddleware (already configured in main.py).
  const url = new URL(window.location.href);
  const BACKEND = url.searchParams.get('api') || 'http://localhost:8100';
  const POLL_SECONDS = Math.max(1, parseInt(url.searchParams.get('poll') || '2', 10));

  document.getElementById('backend-url').textContent = BACKEND;
  document.getElementById('poll-interval').textContent = POLL_SECONDS;

  const pollStatus = document.getElementById('poll-status');
  const personasRoot = document.getElementById('personas');
  const banner = document.getElementById('reconcile-banner');
  const bannerVerdict = document.getElementById('reconcile-verdict');
  const bannerMath = document.getElementById('reconcile-math');
  const bannerNote = document.getElementById('reconcile-note');
  const reconcileBtn = document.getElementById('reconcile-btn');

  // Track seen webhook + tx ids so we flash the row when one is new.
  const seenWebhooks = new Set();
  const seenTransactions = new Set();
  let firstRender = true;

  // ---- formatters ------------------------------------------------------------

  const fmtNaira = (kobo) => {
    const naira = (kobo / 100);
    return '₦' + naira.toLocaleString('en-NG', { maximumFractionDigits: 0 });
  };

  const fmtRelative = (unixSeconds) => {
    const deltaS = Math.floor(Date.now() / 1000) - unixSeconds;
    if (deltaS < 5) return 'just now';
    if (deltaS < 60) return `${deltaS}s ago`;
    const m = Math.floor(deltaS / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  };

  // ---- main poll loop --------------------------------------------------------

  async function poll() {
    try {
      const res = await fetch(`${BACKEND}/admin/state`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body.success) throw new Error('non-success envelope');
      renderState(body.data);
      pollStatus.textContent = `last poll · ${new Date().toLocaleTimeString()}`;
      pollStatus.style.color = 'var(--success)';
    } catch (e) {
      pollStatus.textContent = `poll error · ${e.message}`;
      pollStatus.style.color = 'var(--danger)';
    }
  }

  function renderState(data) {
    personasRoot.innerHTML = '';
    for (const p of data.personas) {
      personasRoot.appendChild(renderPersona(p));
    }
    firstRender = false;
  }

  function renderPersona(p) {
    const card = document.createElement('div');
    card.className = 'persona-card';

    const header = document.createElement('div');
    header.innerHTML = `
      <h2>${escapeHtml(p.persona_name)}</h2>
      <div class="va">GTBank · ${formatVa(p.wallet.squad_va_number)}</div>
    `;
    card.appendChild(header);

    // Balances
    const balances = document.createElement('div');
    balances.className = 'balances';
    balances.innerHTML = `
      <div class="balance-block">
        <div class="label">ONLINE</div>
        <div class="value">${fmtNaira(p.wallet.balance_kobo)}</div>
      </div>
      <div class="balance-block">
        <div class="label">OFFLINE</div>
        <div class="value">${fmtNaira(p.wallet.locked_kobo)}</div>
      </div>
    `;
    card.appendChild(balances);

    // Credit score
    card.appendChild(renderCreditScore(p.credit_score));

    // Recent transactions
    const txSection = document.createElement('div');
    txSection.className = 'section';
    txSection.innerHTML = '<h3>RECENT ACTIVITY</h3>';
    const txList = document.createElement('div');
    txList.className = 'row-list';
    if (p.recent_transactions.length === 0) {
      txList.innerHTML = '<div class="row-empty">no transactions yet</div>';
    } else {
      for (const tx of p.recent_transactions) {
        txList.appendChild(renderTxRow(tx));
      }
    }
    txSection.appendChild(txList);
    card.appendChild(txSection);

    // Webhook events
    const evSection = document.createElement('div');
    evSection.className = 'section';
    evSection.innerHTML = '<h3>WEBHOOKS</h3>';
    const evList = document.createElement('div');
    evList.className = 'row-list';
    if (p.recent_webhook_events.length === 0) {
      evList.innerHTML = '<div class="row-empty">no webhooks yet</div>';
    } else {
      for (const ev of p.recent_webhook_events) {
        evList.appendChild(renderEventRow(ev));
      }
    }
    evSection.appendChild(evList);
    card.appendChild(evSection);

    return card;
  }

  function renderCreditScore(cs) {
    const block = document.createElement('div');
    block.className = 'credit-score';
    const bd = cs.breakdown;
    block.innerHTML = `
      <div class="row">
        <span class="label">CREDIT SCORE</span>
        <span class="score">${cs.score}</span>
      </div>
      <div class="breakdown">
        <span class="key">base</span><span class="val">${bd.base}</span>
        <span class="key">+ account age</span><span class="val">${bd.account_age_bonus}</span>
        <span class="key">+ inbound activity</span><span class="val">${bd.inbound_bonus}</span>
        <span class="key">+ transfer activity</span><span class="val">${bd.transfer_bonus}</span>
        <span class="key">+ balance ≥ ₦10k</span><span class="val">${bd.balance_bonus}</span>
        <span class="key penalty">− failed</span><span class="val penalty">${bd.failed_penalty}</span>
        <span class="key">= raw</span><span class="val">${bd.raw_total}</span>
      </div>
    `;
    return block;
  }

  function renderTxRow(tx) {
    const div = document.createElement('div');
    div.className = 'row-item';
    const isNew = !firstRender && !seenTransactions.has(tx.id);
    if (isNew) div.classList.add('flash');
    seenTransactions.add(tx.id);

    const dirClass = tx.direction === 'in' ? 'badge-in' : 'badge-out';
    const statusBadge = `badge-${tx.status}`;
    const sign = tx.direction === 'in' ? '+' : '−';

    div.innerHTML = `
      <div class="left">
        <span class="badge ${dirClass}">${tx.direction.toUpperCase()}</span>
        <span class="badge ${statusBadge}">${tx.status}</span>
        <span class="ref">${escapeHtml(tx.type)} · ${fmtRelative(tx.created_at)}</span>
      </div>
      <span class="amount">${sign}${fmtNaira(tx.amount_kobo)}</span>
    `;
    return div;
  }

  function renderEventRow(ev) {
    const div = document.createElement('div');
    div.className = 'row-item';
    const isNew = !firstRender && !seenWebhooks.has(ev.transaction_ref);
    if (isNew) div.classList.add('flash');
    seenWebhooks.add(ev.transaction_ref);

    const versionBadge = ev.signature_version_matched
      ? `<span class="badge badge-${ev.signature_version_matched}">${ev.signature_version_matched}</span>`
      : '';
    const mismatchBadge = ev.mismatch === 1
      ? '<span class="badge badge-mismatch">mismatch</span>'
      : '';

    div.innerHTML = `
      <div class="left">
        ${versionBadge}
        ${mismatchBadge}
        <span class="ref">${escapeHtml(ev.transaction_ref)} · ${fmtRelative(ev.processed_at)}</span>
      </div>
    `;
    return div;
  }

  function formatVa(va) {
    if (!va) return '—';
    if (va.length === 10) {
      return `${va.slice(0, 4)} ${va.slice(4, 7)} ${va.slice(7)}`;
    }
    return va;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // ---- reconcile button ------------------------------------------------------

  reconcileBtn.addEventListener('click', async () => {
    reconcileBtn.disabled = true;
    reconcileBtn.textContent = 'Reconciling…';
    try {
      const res = await fetch(`${BACKEND}/admin/reconcile`, {
        method: 'POST',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body.success) throw new Error('non-success envelope');
      showReconcileBanner(body.data);
    } catch (e) {
      banner.classList.remove('show', 'holds', 'drift');
      banner.classList.add('show', 'drift');
      bannerVerdict.textContent = `✗ RECONCILE FAILED`;
      bannerMath.textContent = e.message;
      bannerNote.textContent = '';
    } finally {
      reconcileBtn.disabled = false;
      reconcileBtn.textContent = 'Run Reconcile';
    }
  });

  function showReconcileBanner(d) {
    banner.classList.remove('holds', 'drift');
    banner.classList.add('show', d.invariant_holds ? 'holds' : 'drift');
    bannerVerdict.textContent = d.invariant_holds
      ? '✓ INVARIANT HOLDS · drift ₦0'
      : `✗ INVARIANT FAILED · drift ${fmtNaira(d.drift_kobo)}`;
    bannerMath.innerHTML = [
      `<div>SUM(balance_kobo)             = ${fmtNaira(d.sum_balance_kobo).padStart(14)}</div>`,
      `<div>SUM(locked_kobo)              = ${fmtNaira(d.sum_locked_kobo).padStart(14)}</div>`,
      `<div>SUM(outstanding_permits)      = ${fmtNaira(d.sum_outstanding_permits_kobo).padStart(14)}    ← M2 only, 0 in M1</div>`,
      `<div>──────────────────────────────────────────</div>`,
      `<div>computed total                = ${fmtNaira(d.computed_total_kobo).padStart(14)}</div>`,
      `<div>master_va_balance             = ${fmtNaira(d.master_va_balance_kobo).padStart(14)}</div>`,
      `<div><strong>drift                         = ${fmtNaira(d.drift_kobo).padStart(14)}</strong></div>`,
    ].join('');
    bannerNote.textContent = d.note || '';
  }

  // ---- boot ------------------------------------------------------------------

  poll();
  setInterval(poll, POLL_SECONDS * 1000);
})();
