import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--import','tsx','--test','tests/managed-browser.test.ts'], { env: { ...process.env, WX_BROWSER_TESTS: '1' }, stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code ?? 1; });
