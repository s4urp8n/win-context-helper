// Constants used across main, renderer, and worker.
module.exports = {
  IPC: {
    INIT: 'plugin:init',           // main → renderer: { manifest, targets }
    START: 'plugin:start',         // renderer → main: { options }
    CANCEL: 'plugin:cancel',       // renderer → main: ()
    PROGRESS: 'plugin:progress',   // main → renderer: { processed, total, current }
    COMPLETE: 'plugin:complete',   // main → renderer: { ok, processed, skipped, errors }
    SHELL_SET_STATE: 'shell:set-state',  // main → renderer: state payload
    SHELL_ACTION:    'shell:action',     // renderer → main: { action }
    SHELL_MIN:       'shell:min',        // renderer → main: minimize window
    SHELL_CLOSE:     'shell:close',      // renderer → main: close window
    SHELL_RESIZE:    'shell:resize',     // renderer → main: { height }
  },
  WORKER_MSG: {
    PROGRESS: 'worker:progress',
    COMPLETE: 'worker:complete',
    ERROR: 'worker:error',
    CANCEL: 'worker:cancel',
    PREFLIGHT_COMPLETE: 'worker:preflight-complete',
    PREFLIGHT_ERROR: 'worker:preflight-error',
  },
};
