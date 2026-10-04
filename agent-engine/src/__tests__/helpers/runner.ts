import { join } from 'node:path';

/** runner 的 build 產物。需要先 build(`npm test` 的 pretest 會做)。 */
export const RUNNER = join(__dirname, '..', '..', '..', 'dist', 'runtimes', 'vercelAi', 'runner.js');
