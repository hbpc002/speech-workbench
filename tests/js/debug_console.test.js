import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { clear, error, info } from '../../static/js/debug_log.js';
import { initDebugConsole, openDebugConsole } from '../../static/js/debug_console.js';
import { installDom, uninstallDom } from './dom_stub.js';

after(() => uninstallDom());

describe('debug console', () => {
  it('opens from the topbar, renders entries, and auto-opens on 5xx', () => {
    clear();
    const dom = installDom({
      ids: [
        'debug-toggle',
        'debug-console',
        'debug-lines',
        'debug-summary',
        'debug-count',
        'debug-errors-only',
        'debug-close',
        'debug-clear',
        'debug-copy',
      ],
    });
    initDebugConsole();

    assert.equal(dom.get('debug-console').hidden, true);
    dom.get('debug-toggle').listeners.click[0]();
    assert.equal(dom.get('debug-console').hidden, false);

    info('hello');
    let row = dom.get('debug-lines').children.at(-1);
    assert.match(row.children[0].children[2].textContent, /hello/);

    error('upstream failed', { status: 502, message: 'boom' });
    assert.equal(dom.get('debug-console').hidden, false, '5xx should auto-open');
    assert.equal(dom.get('debug-count').hidden, false);
    assert.equal(dom.get('debug-count').textContent, '1');
    row = dom.get('debug-lines').children.at(-1);
    assert.match(row.children[0].children[2].textContent, /upstream failed/);

    openDebugConsole();
    dom.get('debug-clear').listeners.click[0]();
    assert.equal(dom.get('debug-lines').children.length, 1);
    assert.match(dom.get('debug-lines').children[0].textContent, /暂无日志/);
  });
});
