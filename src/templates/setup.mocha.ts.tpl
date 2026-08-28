import sinon from 'sinon';
import { use } from 'chai';
import sinonChai from 'sinon-chai';

use(sinonChai);

// Provide global vi fallback for Mocha Node tests
if (typeof (globalThis as any).vi === 'undefined') {
  (globalThis as any).vi = {
    fn: (...args: any[]) => sinon.stub(...args),
    spyOn: (obj: any, method: string) => sinon.spy(obj, method),
    hoisted: (fn: () => any) => fn(),
    mock: () => {},
    unmock: () => {},
    resetAllMocks: () => sinon.restore(),
    clearAllMocks: () => sinon.reset(),
    restoreAllMocks: () => sinon.restore()
  };
}
