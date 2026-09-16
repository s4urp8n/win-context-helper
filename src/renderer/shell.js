const app = document.getElementById('app');
const closeButton = document.getElementById('ctrl-close');
app.dataset.state = 'scanning';

// Tables need room for two or three columns of long file names.
const TABLE_WIDTH = 760;

// Natural height of the page. The body is pinned to the window height, so that a long table
// scrolls instead of pushing the buttons out of a capped window; it is released to measure.
function contentHeight() {
  document.body.style.height = 'auto';
  const h = Math.ceil(document.body.getBoundingClientRect().height);
  document.body.style.height = '';
  return h;
}

function requestResize(wide = false) {
  // Two RAFs: first lets the browser apply the state-data attribute change,
  // second measures after layout has settled.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (wide && window.innerWidth < TABLE_WIDTH) {
        // Widen first, then measure again: rows wrap less in a wider window.
        window.addEventListener('resize', () => requestResize(), { once: true });
        window.shell.resize(contentHeight(), TABLE_WIDTH);
        return;
      }
      window.shell.resize(contentHeight());
    });
  });
}

// table: { columns: [..], rows: [{ cells: [..], badges?: [..] } | { group }], footer? }
// Returns true when the table has rows to show.
function renderTable(container, table) {
  container.replaceChildren();
  const hasRows = !!(table && table.rows && table.rows.length > 0);
  container.hidden = !hasRows;
  if (!hasRows) return false;

  // The column titles and every group are separate tables with equal fixed columns, so they
  // line up. A group lives in its own block: its sticky title leaves together with its rows
  // (sticky cells inside one table would all pile up under the column titles).
  const addTable = (parent) => parent.appendChild(document.createElement('table'));
  const titles = addTable(container);
  titles.className = 'titles';
  const head = titles.createTHead().insertRow();
  for (const title of table.columns) {
    const th = document.createElement('th');
    th.textContent = title;
    head.appendChild(th);
  }
  let body = addTable(container).createTBody();
  let stripe = 0;
  for (const row of table.rows) {
    if (row.group !== undefined) {
      const group = container.appendChild(document.createElement('div'));
      group.className = 'group';
      const caption = group.appendChild(document.createElement('div'));
      caption.className = 'group-title';
      caption.textContent = row.group;
      body = addTable(group).createTBody();
      stripe = 0;
      continue;
    }
    const tr = body.insertRow();
    if (stripe++ % 2 === 1) tr.className = 'even';
    for (const text of row.cells || []) tr.insertCell().textContent = text;
    for (const badge of row.badges || []) {
      const span = document.createElement('span');
      span.className = 'badge';
      span.textContent = badge;
      tr.lastElementChild.append(span);
    }
  }

  if (table.footer) {
    const footer = document.createElement('div');
    footer.className = 'table-footer';
    footer.textContent = table.footer;
    container.appendChild(footer);
  }
  return true;
}

// facts: [{ label, value, tone? }] — the summary as short label/value lines.
function renderFacts(container, facts) {
  const list = facts || [];
  container.hidden = list.length === 0;
  container.replaceChildren(...list.flatMap((fact) => {
    const label = document.createElement('dt');
    label.textContent = fact.label;
    const value = document.createElement('dd');
    value.textContent = fact.value;
    if (fact.tone) value.className = fact.tone;
    return [label, value];
  }));
}

// options: [{ name, label, checked, disabled?, nested? }]. The checkboxes are updated in place
// when the list stays the same, so the one just clicked keeps the keyboard focus.
function renderOptions(container, options) {
  const list = options || [];
  container.hidden = list.length === 0;
  const names = (items) => items.map((o) => o.name).join('\n');
  const inputs = () => [...container.querySelectorAll('input')];
  if (names(inputs()) !== names(list)) {
    container.replaceChildren(...list.map((o) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = o.name;
      const text = document.createElement('span');
      text.textContent = o.label;
      label.append(input, text);
      return label;
    }));
  }
  inputs().forEach((input, i) => {
    const o = list[i];
    input.checked = !!o.checked;
    input.disabled = !!o.disabled;
    input.parentElement.className = ['option', o.nested && 'nested', o.disabled && 'disabled'].filter(Boolean).join(' ');
  });
}

const confirmOptions = document.getElementById('confirm-options');
const continueButton = document.querySelector('section[data-state="confirm"] button[data-action="continue"]');
confirmOptions.addEventListener('change', () => {
  const options = {};
  for (const input of confirmOptions.querySelectorAll('input')) options[input.name] = input.checked;
  // The plan on screen no longer matches the options; Continue waits for the new one.
  continueButton.disabled = true;
  window.shell.send({ action: 'options', options });
});

window.shell.onSetState((payload) => {
  const entering = app.dataset.state !== payload.state;
  app.dataset.state = payload.state;
  // A started operation cannot be cancelled, so its window cannot be closed either.
  closeButton.disabled = payload.state === 'running';
  closeButton.title = closeButton.disabled ? 'The operation cannot be cancelled' : 'Close';
  let wide = false;
  if (payload.state === 'scanning' || payload.state === 'running') {
    const id = payload.state + '-label';
    if (payload.label) document.getElementById(id).textContent = payload.label;
    updateProgress(payload.state, payload.progress);
  } else if (payload.state === 'info' || payload.state === 'confirm' || payload.state === 'error') {
    document.getElementById(payload.state + '-message').textContent = payload.message || '';
    document.getElementById(payload.state + '-detail').textContent = payload.detail || '';
    wide = renderTable(document.getElementById(payload.state + '-table'), payload.table);
    if (payload.state === 'confirm') {
      renderOptions(confirmOptions, payload.options);
      const facts = document.getElementById('confirm-facts');
      renderFacts(facts, payload.facts);
      // Each block of the confirm gets a title; a block with nothing to show hides it too.
      const tableTitle = document.getElementById('confirm-table-title');
      tableTitle.textContent = payload.tableTitle || 'Preview';
      tableTitle.hidden = !wide;
      document.getElementById('confirm-options-title').hidden = confirmOptions.hidden;
      document.getElementById('confirm-summary-title').hidden = facts.hidden && !payload.detail;
      continueButton.disabled = payload.canContinue === false;
    }
    // Enter acknowledges a message, but never starts an operation that cannot be undone.
    // A confirm rebuilt after an option change leaves the focus where the user put it.
    const target = payload.state === 'confirm' ? 'button[data-action="cancel"]' : 'button.primary';
    if (entering) setTimeout(() => {
      const btn = document.querySelector(`section.state[data-state="${payload.state}"] ${target}`);
      if (btn) btn.focus();
    }, 0);
  } else if (payload.state === 'form') {
    document.getElementById('form-message').textContent = payload.message || '';
    document.getElementById('form-summary').textContent = payload.summary || '';
    document.getElementById('form-fields').innerHTML = payload.uiHtml || '';
    setTimeout(() => {
      const first = document.querySelector('#form-fields input:not([type="hidden"]), #form-fields select, #form-fields textarea');
      if (first) first.focus();
    }, 0);
  }
  requestResize(wide);
});

function updateProgress(stateName, progress) {
  const container = document.getElementById(stateName + '-progress');
  if (!container) return;
  const section = document.querySelector(`section.state[data-state="${stateName}"]`);
  if (!progress) {
    container.style.display = 'none';
    if (section) section.classList.remove('has-progress');
    return;
  }
  container.style.display = 'block';
  const textEl = document.getElementById(stateName + '-progress-text');
  if (stateName === 'scanning') {
    if (typeof progress.scanned === 'number') {
      textEl.textContent = progress.scanned.toLocaleString() + ' files scanned';
    }
  } else if (stateName === 'running') {
    const { processed = 0, total = 0 } = progress;
    const pct = total > 0 ? Math.round(processed / total * 100) : 0;
    const fill = document.getElementById('running-progress-fill');
    if (fill) fill.style.width = pct + '%';
    textEl.textContent = `${processed.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
    // Hide spinner once we have a real progress bar — redundant motion otherwise.
    if (section) section.classList.add('has-progress');
  }
}

function harvestFormOptions() {
  const form = document.getElementById('form-fields');
  const options = {};
  if (!form) return options;
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      const existing = options[el.name];
      if (Array.isArray(existing)) {
        if (el.checked) existing.push(el.value || true);
      } else if (existing !== undefined) {
        options[el.name] = [existing];
        if (el.checked) options[el.name].push(el.value || true);
      } else {
        if (el.value && el.value !== 'on') {
          options[el.name] = el.checked ? [el.value] : [];
        } else {
          options[el.name] = el.checked;
        }
      }
    } else if (el.type === 'radio') {
      if (el.checked) options[el.name] = el.value;
    } else if (el.type === 'number') {
      options[el.name] = Number(el.value);
    } else {
      options[el.name] = el.value;
    }
  }
  return options;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'start') {
    window.shell.send({ action: 'start', options: harvestFormOptions() });
  } else {
    window.shell.send(action);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Treat Escape as cancel for confirm, OK for info/error
    const state = app.dataset.state;
    if (state === 'confirm') window.shell.send('cancel');
    else if (state === 'info' || state === 'error') window.shell.send('ok');
  }
});

document.getElementById('ctrl-min').addEventListener('click', () => {
  window.shell.minimize();
});
document.getElementById('ctrl-close').addEventListener('click', () => {
  window.shell.close();
});

requestResize();
