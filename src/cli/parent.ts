import { execFile } from 'node:child_process';

/** How many processes up the tree are watched: the shell of the npm script, npm, and what started npm. */
const LEVELS = 3;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // No permission to signal it still means it is there.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pids of the parent, its parent and so on, as far as they can be found. */
function ancestors(done: (pids: number[]) => void): void {
  if (process.platform === 'win32') {
    const script =
      `$p = ${process.pid}; $found = @(); ` +
      `for ($i = 0; $i -lt ${LEVELS}; $i++) { ` +
      `$x = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if (-not $x) { break }; $p = $x.ParentProcessId; $found += $p }; ` +
      `$found -join ','`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      done(error ? [] : stdout.trim().split(',').map(Number).filter((pid) => pid > 0));
    });
    return;
  }
  const pids: number[] = [];
  const climb = (pid: number): void => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (error, stdout) => {
      const parent = error ? 0 : Number(stdout.trim());
      // 1 is init, which every orphan is handed to: it says nothing about who started us.
      if (parent > 1) pids.push(parent);
      if (parent > 1 && pids.length < LEVELS) climb(parent);
      else done(pids);
    });
  };
  climb(process.pid);
}

/**
 * Calls `stop` when the process that started this one is gone.
 *
 * `npm run dev` puts a shell and npm between the terminal and this process. When npm is ended
 * from outside (a task runner, a script, a closed editor) Windows ends only that one process
 * and leaves its children running, and a dev server nobody can see keeps its port. So the
 * processes above this one are looked up once and checked every second.
 */
export function onParentExit(stop: () => void): void {
  const first = process.ppid;
  // One that is already gone was left behind on purpose, and is no reason to stop.
  let watched = [first].filter(alive);
  ancestors((pids) => {
    if (pids.length > 0) watched = pids.filter(alive);
  });
  const timer = setInterval(() => {
    // Elsewhere than on Windows an orphan gets a new parent, which is the same news.
    if (process.ppid !== first || watched.some((pid) => !alive(pid))) {
      clearInterval(timer);
      stop();
    }
  }, 1000);
  timer.unref();
}
