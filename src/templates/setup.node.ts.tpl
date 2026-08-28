import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { use } from 'chai';
import chaiAsPromised from 'chai-as-promised';

use(chaiAsPromised);

// Shim Mocha BDD hooks to Vitest equivalents
(globalThis as any).before = beforeAll;
(globalThis as any).after = afterAll;
(globalThis as any).beforeEach = beforeEach;
(globalThis as any).afterEach = afterEach;
