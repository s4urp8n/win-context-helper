const app = document.getElementById('app');
app.dataset.state = 'scanning';

function requestResize() {
  // Two RAFs: first lets the browser apply the state-data attribute change,
  // second measures after layout has settled.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const h = document.documentElement.scrollHeight;
      window.shell.resize(h);
    });
  });
}

window.shell.onSetState((payload) => {
  app.dataset.state = payload.state;
  if (payload.state === 'scanning' || payload.state === 'running') {
    const id = payload.state + '-label';
    if (payload.label) document.getElementById(id).textContent = payload.label;
    updateProgress(payload.state, payload.progress);
  } else if (payload.state === 'info' || payload.state === 'confirm' || payload.state === 'error') {
    document.getElementById(payload.state + '-message').textContent = payload.message || '';
    document.getElementById(payload.state + '-detail').textContent = payload.detail || '';
    // Focus the primary button so Enter activates it
    setTimeout(() => {
      const btn = document.querySelector(`[data-state="${payload.state}"] button.primary`);
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
  requestResize();
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
