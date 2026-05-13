const net = require('node:net');

const PIPE_PREFIX = '\\\\.\\pipe\\';

function pipePath(name) {
  return PIPE_PREFIX + name;
}

// Try to connect to an existing pipe as a follower. Resolves true if successful.
function tryFollower({ pipeName, myTarget }) {
  return new Promise((resolve) => {
    const socket = net.connect(pipePath(pipeName));
    let done = false;
    socket.once('connect', () => {
      socket.end(myTarget + '\n', 'utf8', () => {
        done = true;
        resolve(true);
      });
    });
    socket.once('error', () => {
      if (!done) resolve(false);
    });
  });
}

// Become leader: create the pipe server, collect targets using an idle-based
// timeout — the timer resets every time a follower delivers its target, so a
// flood of 10+ Explorer-launched processes (which can spread out beyond a
// fixed 250 ms window) all aggregate into one batch. A hard ceiling
// (maxWaitMs) prevents an unbounded wait if instances keep arriving.
function startLeader({ pipeName, myTarget, idleMs, maxWaitMs }) {
  return new Promise((resolve, reject) => {
    const targets = [myTarget];
    let idleTimer = null;
    let hardTimer = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      server.close(() => resolve({ role: 'leader', targets }));
    };
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, idleMs);
    };

    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
      });
      conn.on('end', () => {
        const line = buf.replace(/\r?\n$/, '');
        if (line) {
          targets.push(line);
          resetIdle();
        }
      });
    });
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        // Race: another process became leader between our tryFollower and listen.
        tryFollower({ pipeName, myTarget }).then((ok) => {
          if (ok) resolve({ role: 'follower', targets: [] });
          else reject(err);
        }).catch(reject);
        return;
      }
      reject(err);
    });
    server.listen(pipePath(pipeName), () => {
      resetIdle();
      hardTimer = setTimeout(finish, maxWaitMs);
    });
  });
}

async function aggregateTargets({ pipeName, myTarget, waitMs = 500, maxWaitMs = 5000 }) {
  const followed = await tryFollower({ pipeName, myTarget });
  if (followed) return { role: 'follower', targets: [] };
  return startLeader({ pipeName, myTarget, idleMs: waitMs, maxWaitMs });
}

module.exports = { aggregateTargets };
